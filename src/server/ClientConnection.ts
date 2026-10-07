import { BucketKey } from "../buckets/BucketKey";
import type { BucketEntry } from "../buckets/BucketEntry";
import type { Filing } from "./Filing";
import type { HeldBuckets } from "../buckets/HeldBuckets";
import { TouchedRows } from "../buckets/TouchedRows";
import { Transaction } from "../transactions";
import type { QueryResult } from "../queries";
import type { TransactionRecord } from "./TransactionRecord";
import {
  decodeClientMessage,
  encodeMessage,
  type BucketCursor,
  type ClientMessage,
  type PresencePeer,
  type PresenceRoomRef,
  type ServerMessage,
  type Socket,
} from "../protocol";
import type { Principal } from "./Principal";
import type { PresenceOccupant } from "./PresenceRooms";
import type { SyncServer } from "./SyncServer";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ScopeChange = Pick<Extract<ServerMessage, { type: "scope" }>, "added" | "removed">;
type ScopeAdded = ScopeChange["added"];

/**
 * One connected client, as the server sees it: the principal it acts as, the
 * buckets it holds, and one outbound queue, so it applies rows in the order
 * the server read them and hears about its own commit only after that
 * commit's effect.
 */
export class ClientConnection implements PresenceOccupant {
  private outbound: Promise<void> = Promise.resolve();
  private held: HeldBuckets | null = null;
  /** Transactions committed through this connection: theirs even before the log says whose they are. */
  private readonly committedHere = new Set<string>();

  constructor(
    private readonly server: SyncServer,
    private readonly socket: Socket,
    private readonly principal: Principal,
  ) {
    socket.onMessage((frame) => {
      let message: ClientMessage;
      try {
        message = decodeClientMessage(frame);
      } catch {
        socket.close();
        return;
      }
      this.handle(message);
    });
  }

  onClose(listener: () => void): void {
    this.socket.onClose(listener);
  }

  close(): void {
    this.socket.close();
  }

  get userId(): string | null {
    return this.principal.authorId;
  }

  hearPresence(room: PresenceRoomRef, peers: PresencePeer[]): void {
    this.enqueue(() => {
      this.send({ type: "presence", room, peers });
      return Promise.resolve();
    });
  }

  /**
   * A logged transaction: the author gets its verdict, holders of a touched
   * bucket get the rows. When it also changed which buckets this identity
   * holds, that change travels in the same message, so the transaction
   * arrives whole: one tick, one message.
   */
  announce(filing: Filing): void {
    this.enqueue(async () => {
      const changes = this.authored(filing.record) || filing.record.isDenied ? null : await this.changesIn(filing);
      const affected = filing.affects(this.principal.authorId);
      const scope = affected ? await this.rescope() : null;
      if (affected) await this.recheckPresence();
      if (this.authored(filing.record)) {
        this.send({ type: "effect", effect: await this.principal.effectOf(filing.record), ...(scope ? { scope } : {}) });
      } else if (changes) {
        this.send({ type: "changed", tick: filing.tick, ...changes, ...(scope ? { scope } : {}) });
      } else if (scope) {
        this.send({ type: "scope", tick: filing.tick, ...scope });
      }
    });
  }

  // Read against the buckets held before this transaction moved any.
  private async changesIn(filing: Filing): Promise<{ buckets: string[]; rows: QueryResult; removed: Record<string, string[]> } | null> {
    if (!this.held) return null;
    const mine = this.held.holdsEverything ? [...filing.entries] : filing.entriesIn(this.held.names());
    const touched = TouchedRows.fromGroups([mine]);
    if (touched.isEmpty) return null;
    const visible = await this.principal.changedRows(touched);
    return { buckets: [...touched.buckets], rows: visible.rows, removed: visible.removed };
  }

  // A membership-like row changed under this identity: its held buckets may
  // have moved, and a gained bucket arrives with everything in it.
  private async rescope(): Promise<ScopeChange | null> {
    if (!this.held || this.held.holdsEverything) return null;
    const previous = this.held;
    this.held = await this.server.heldBy(this.principal);
    const diff = this.held.diff(previous);
    if (diff.added.length === 0 && diff.removed.length === 0) return null;
    return { added: await this.contentsOf(diff.added), removed: diff.removed.map(String) };
  }

  private async contentsOf(keys: readonly BucketKey[]): Promise<ScopeAdded> {
    const added: ScopeAdded = [];
    for (const key of keys) {
      added.push({
        key: key.toJSON(),
        generation: this.server.scheme.of(key.model).generation,
        rows: { [key.model]: await this.principal.bucketRows(key) },
      });
    }
    return added;
  }

  // Access to a room's row may have ended with this transaction.
  private async recheckPresence(): Promise<void> {
    for (const room of this.server.presence.roomsOf(this)) {
      if (await this.principal.canRead(room.entity, room.id)) continue;
      this.server.presence.leave(room, this);
      this.send({ type: "presenceRefused", room });
    }
  }

  private async enterPresence(room: PresenceRoomRef, state: Extract<ClientMessage, { type: "presence" }>["state"]): Promise<void> {
    const inside = this.server.presence.roomsOf(this).some((entered) => entered.entity === room.entity && entered.id === room.id);
    if (!inside && !(await this.principal.canRead(room.entity, room.id))) {
      this.send({ type: "presenceRefused", room });
      return;
    }
    this.server.presence.set(room, this, state);
  }

  private handle(message: ClientMessage): void {
    switch (message.type) {
      case "presence":
        this.enqueue(() => this.enterPresence(message.room, message.state));
        return;
      case "leavePresence":
        this.enqueue(() => {
          this.server.presence.leave(message.room, this);
          return Promise.resolve();
        });
        return;
      case "hello":
        this.enqueue(() => this.hello(message.cursors, message.generations));
        return;
      case "pull":
        this.enqueue(async () => {
          try {
            this.send({ type: "pulled", requestId: message.requestId, data: await this.principal.query(message.query) });
          } catch (error) {
            this.send({ type: "failed", requestId: message.requestId, message: messageOf(error) });
          }
        });
        return;
      case "commit": {
        const transaction = new Transaction(message.transaction.id, message.transaction.changes);
        this.committedHere.add(transaction.id);
        this.enqueue(async () => {
          try {
            // Sent again after a lost reply: nothing to apply, the author
            // just needs the verdict it missed.
            const known = await this.principal.recordOf(transaction.id);
            if (known) {
              this.send({ type: "effect", effect: await this.principal.effectOf(known) });
              return;
            }
            // Logged but not yet read from the WAL: the feed announces it to
            // this connection, which now counts as its author.
            if (await this.principal.hasLogged(transaction.id)) {
              await this.server.feed.catchUp();
              return;
            }
            await this.principal.write(transaction);
          } catch (error) {
            this.send({ type: "failed", requestId: message.requestId, message: messageOf(error) });
          }
        });
        return;
      }
    }
  }

  /**
   * Where the client stands against where it should be: models whose policy
   * changed start over, buckets it no longer holds go, buckets it newly
   * holds arrive whole, and buckets it kept catch up from their cursors.
   */
  private async hello(cursors: readonly BucketCursor[], generations: Record<string, string>): Promise<void> {
    const tick = await this.principal.currentTick();
    this.held = await this.server.heldBy(this.principal);
    // A model this server no longer has is as stale as one whose policy
    // changed: the client drops its rows and cursors either way.
    const stale = new Set(Object.entries(generations)
      .filter(([model, generation]) => !this.server.scheme.has(model) || this.server.scheme.of(model).generation !== generation)
      .map(([model]) => model));
    if (stale.size > 0) this.send({ type: "resync", models: [...stale] });

    const usable = new Map(cursors.filter((cursor) => !stale.has(cursor.model)).map((cursor) => [cursor.bucket, cursor.tick]));
    const added: BucketKey[] = [];
    const groups: BucketEntry[][] = [];
    const caughtUp: string[] = [];
    for (const key of this.held.keys()) {
      const cursor = usable.get(key.toString());
      if (cursor === undefined) {
        added.push(key);
        continue;
      }
      const since = await this.server.bucketLog.since(key, cursor);
      if (since.length > 0) {
        groups.push(...since);
        caughtUp.push(key.toString());
      }
    }
    const removed = [...usable.keys()].filter((bucket) => !this.held?.holds(bucket));
    if (added.length > 0 || removed.length > 0) {
      this.send({ type: "scope", tick, added: await this.contentsOf(added), removed });
    }
    const touched = TouchedRows.fromGroups(groups);
    if (!touched.isEmpty) {
      const visible = await this.principal.changedRows(touched);
      this.send({ type: "changed", tick, buckets: caughtUp, rows: visible.rows, removed: visible.removed });
    }
    this.send({ type: "ready", tick });
  }

  private authored(record: TransactionRecord): boolean {
    return this.committedHere.has(record.id) || (record.authorId !== null && record.authorId === this.principal.authorId);
  }

  private enqueue(job: () => Promise<void>): void {
    this.outbound = this.outbound.then(job).catch(() => { this.socket.close(); });
  }

  private send(message: ServerMessage): void {
    this.socket.send(encodeMessage(message));
  }
}
