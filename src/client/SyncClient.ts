import type { SchemaDef } from "@zenstackhq/schema";
import { v4 as uuid } from "uuid";
import { BucketKey } from "../buckets/BucketKey";
import { LiveSubscription, type QuerySubscriptionState, type Unsubscribe } from "../subscriptions";
import { type QueryResult, type UntypedQuery } from "../queries";
import { type Transaction, type TransactionEffect, type TransactionOutcome } from "../transactions";
import {
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type PresenceRoomRef,
  type ServerMessage,
  type Socket,
} from "../protocol";
import type { LocalReplica } from "./LocalReplica";
import { ReplicaGate } from "./ReplicaGate";
import { PresenceRoom } from "./PresenceRoom";

export type DenialListener = (denial: TransactionEffect) => void;

const FIRST_RETRY_MS = 50;
const MAX_RETRY_MS = 1000;

/** A reply the client is waiting for, settled by the server or by the connection going away. */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

// Node timers keep the process alive; a retry timer of a client nobody is
// using any more must not.
function isUnrefable(timer: unknown): timer is { unref(): void } {
  return typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function";
}

class ConnectionLost extends Error {
  constructor() {
    super("sync connection lost");
  }
}

function commitMessage(transaction: Transaction): ClientMessage {
  return {
    type: "commit",
    requestId: transaction.id,
    transaction: { id: transaction.id, changes: [...transaction.changes] },
  };
}

function presenceKey(room: PresenceRoomRef): string {
  return `${room.entity}/${room.id}`;
}

type ScopeChange = Pick<Extract<ServerMessage, { type: "scope" }>, "added" | "removed">;
type ChangedMessage = Extract<ServerMessage, { type: "changed" }>;

/**
 * The one way to read and write synced data, wherever the code runs — a
 * device, a browser, or backend code beside the server. The replica is the
 * union of the buckets this client holds; the server keeps it current and
 * every subscription answers from it. A one-off query asks the server first
 * while connected. This client's own transactions are applied at once and
 * kept pending until the server has answered. The connection comes and
 * goes; the client reconnects on its own and resumes from its cursors.
 */
export class SyncClient<Schema extends SchemaDef = SchemaDef> {
  private readonly replica: Promise<LocalReplica>;
  private readonly pendingPulls = new Map<string, Deferred<QueryResult>>();
  /** Callers waiting for the server's verdict on a transaction, by its id. */
  private readonly awaitingVerdicts = new Map<string, Set<Deferred<TransactionOutcome>>>();
  private readonly subscriptions = new Set<LiveSubscription>();
  private readonly denialListeners = new Set<DenialListener>();
  private inbox: Promise<void> = Promise.resolve();
  private socket: Socket | null = null;
  private connected = false;
  private disposed = false;
  private retryMs = FIRST_RETRY_MS;
  /**
   * Settled once the first hello has been answered in full, or once it is
   * clear no server can be reached: reads wait for it, so what they see is
   * the replica as the server left it, not whatever happened to be local.
   */
  private readonly initialSync = new Deferred<void>();
  private readonly gate = new ReplicaGate();
  private readonly presenceRooms = new Map<string, { room: PresenceRoom; holders: number }>();

  constructor(
    readonly schema: Schema,
    private readonly connect: () => Socket,
    replica: LocalReplica | Promise<LocalReplica>,
  ) {
    this.replica = Promise.resolve(replica);
    void this.establish();
  }

  async query(query: UntypedQuery): Promise<QueryResult> {
    await this.initialSync.promise;
    await this.pull(query);
    return this.gate.read(async () => (await this.replica).read(query));
  }

  /**
   * Applies the transaction locally and records it as pending, then sends it
   * when a connection exists; otherwise it goes out on the next one. Resolves
   * once applied here: the server's answer is `verdict`'s.
   */
  async submit(transaction: Transaction): Promise<void> {
    if (transaction.isEmpty) return;
    await this.initialSync.promise;
    await this.gate.write(async () => {
      const replica = await this.replica;
      await replica.applyOwn(transaction);
      await replica.log.addPending(transaction);
    });
    this.refreshSubscriptions();
    if (this.connected) this.send(commitMessage(transaction));
  }

  /**
   * The server's answer on one of this client's transactions, `committed`
   * or `denied`, however long it takes: across disconnects, until the
   * transaction has reached the server. `signal` stops waiting.
   */
  async verdict(transactionId: string, options: { signal?: AbortSignal } = {}): Promise<TransactionOutcome> {
    const { signal } = options;
    signal?.throwIfAborted();
    const waiting = new Deferred<TransactionOutcome>();
    const waiters = this.awaitingVerdicts.get(transactionId) ?? new Set<Deferred<TransactionOutcome>>();
    this.awaitingVerdicts.set(transactionId, waiters);
    waiters.add(waiting);
    const stop = (): void => { waiting.reject(signal?.reason instanceof Error ? signal.reason : new Error("Waiting for the verdict was aborted.")); };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const known = await (await this.replica).log.verdictOn(transactionId);
      if (known) waiting.resolve(known);
      return await waiting.promise;
    } finally {
      signal?.removeEventListener("abort", stop);
      waiters.delete(waiting);
      if (waiters.size === 0) this.awaitingVerdicts.delete(transactionId);
    }
  }

  /** Submits the transaction; online, resolves with the server's verdict, offline with `pending`. */
  async commit(transaction: Transaction): Promise<TransactionOutcome> {
    if (transaction.isEmpty) return transaction.outcome("committed");
    await this.submit(transaction);
    if (!this.connected) return transaction.outcome("pending");
    return this.verdict(transaction.id);
  }

  subscribe(query: UntypedQuery, listener: (state: QuerySubscriptionState) => void): Unsubscribe {
    const subscription = new LiveSubscription(() => this.gate.read(async () => (await this.replica).read(query)), listener);
    let cancelled = false;
    void this.initialSync.promise.then(() => {
      if (cancelled) return;
      this.subscriptions.add(subscription);
      subscription.refresh();
    });
    return () => {
      cancelled = true;
      subscription.stop();
      this.subscriptions.delete(subscription);
    };
  }

  /**
   * This device's place in the presence room of one row, entered at once.
   * Whoever may read the row may be in its room. Every call holds the room
   * and shares one handle; the device leaves once each holder has called
   * `leave()`.
   */
  presence(entity: string, id: string): PresenceRoom {
    const key = presenceKey({ entity, id });
    const existing = this.presenceRooms.get(key);
    if (existing) {
      existing.holders += 1;
      return existing.room;
    }
    const room = new PresenceRoom({ entity, id }, {
      send: (ref, state) => { this.send({ type: "presence", room: ref, state }); },
      leave: (left) => {
        const held = this.presenceRooms.get(key);
        if (!held || held.room !== left) return;
        held.holders -= 1;
        if (held.holders > 0) return;
        this.presenceRooms.delete(key);
        left.close();
        this.send({ type: "leavePresence", room: left.ref });
      },
    });
    this.presenceRooms.set(key, { room, holders: 1 });
    room.enter();
    return room;
  }

  /** Told of every denied transaction of this client's, however late the verdict arrives. */
  onTransactionDenied(listener: DenialListener): Unsubscribe {
    this.denialListeners.add(listener);
    return () => {
      this.denialListeners.delete(listener);
    };
  }

  close(): void {
    this.disposed = true;
    this.socket?.close();
  }

  /** Pulls when connected; otherwise the replica is all there is. */
  private async pull(query: UntypedQuery): Promise<void> {
    if (!this.connected) return;
    const requestId = uuid();
    const reply = new Deferred<QueryResult>();
    this.pendingPulls.set(requestId, reply);
    this.send({ type: "pull", requestId, query });
    try {
      await reply.promise;
    } catch (error) {
      if (!(error instanceof ConnectionLost)) throw error;
    }
  }

  private async establish(): Promise<void> {
    if (this.disposed || this.socket) return;
    let socket: Socket;
    try {
      socket = this.connect();
    } catch {
      this.initialSync.resolve();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onMessage((frame) => { this.receive(frame); });
    socket.onClose(() => { this.handleClose(socket); });
    const replica = await this.replica;
    this.send({ type: "hello", cursors: await replica.cursors.all(), generations: await replica.cursors.generations() });
    this.connected = true;
    this.retryMs = FIRST_RETRY_MS;
    for (const transaction of await replica.log.pending()) this.send(commitMessage(transaction));
    for (const { room } of this.presenceRooms.values()) room.enter();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const timer: unknown = setTimeout(() => { void this.establish(); }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    if (isUnrefable(timer)) timer.unref();
  }

  private send(message: ClientMessage): void {
    this.socket?.send(encodeMessage(message));
  }

  // One at a time, in arrival order: the server sends rows in the order it
  // read them, and applying them out of order could put older rows on top.
  // Every message ends with the rebase, inside the same write, so no read
  // sees server rows without this client's unconfirmed writes on top.
  private receive(frame: string): void {
    this.inbox = this.inbox
      .then(() => this.gate.write(async () => {
        await this.handle(decodeServerMessage(frame));
        await (await this.replica).rebase();
      }))
      .catch(() => { this.socket?.close(); });
  }

  private async handle(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.initialSync.resolve();
        return;
      case "effect":
        await this.applyEffect(message.effect, message.scope ?? null);
        return;
      case "changed":
        await this.applyChanged(message);
        return;
      case "scope":
        await this.applyScope(message, message.tick);
        this.refreshSubscriptions();
        return;
      case "resync":
        await this.resync(message.models);
        return;
      case "pulled":
        await (await this.replica).absorb(message.data);
        this.refreshSubscriptions();
        this.settle(this.pendingPulls, message.requestId)?.resolve(message.data);
        return;
      case "failed": {
        const error = new Error(message.message);
        this.settle(this.pendingPulls, message.requestId)?.reject(error);
        return;
      }
      case "presence":
        this.presenceRooms.get(presenceKey(message.room))?.room.heard(message.peers);
        return;
      case "presenceRefused":
        this.presenceRooms.get(presenceKey(message.room))?.room.refuse();
        return;
    }
  }

  // A denial of one of this client's own transactions arrives with the
  // server's rows for everything it touched: applying it is the undo.
  private async applyEffect(effect: TransactionEffect, scope: ScopeChange | null): Promise<void> {
    const replica = await this.replica;
    const own = await replica.log.isOwnPending(effect.transactionId);
    await replica.apply(effect);
    await replica.log.record(effect);
    if (scope) await this.applyScope(scope, effect.tick);
    this.refreshSubscriptions();
    // The undo first, so whoever awaits the verdict sees the models taken back.
    if (own && effect.status === "denied") this.reportDenial(effect);
    for (const waiting of this.awaitingVerdicts.get(effect.transactionId) ?? []) waiting.resolve(effect);
  }

  private async applyChanged(message: ChangedMessage): Promise<void> {
    const replica = await this.replica;
    await replica.restore(message.rows);
    for (const [entity, ids] of Object.entries(message.removed)) await replica.remove(entity, ids);
    await replica.cursors.advance(message.buckets, message.tick);
    if (message.scope) await this.applyScope(message.scope, message.tick);
    this.refreshSubscriptions();
  }

  // A lost bucket's rows go by the bucket's own filter: nothing else in the
  // replica points at them, and the server may not name them any more.
  private async applyScope(scope: ScopeChange, tick: number): Promise<void> {
    const replica = await this.replica;
    for (const bucket of scope.removed) {
      const held = await replica.cursors.take(bucket);
      if (held) await replica.removeMatching(held.model, held.filter);
    }
    for (const added of scope.added) {
      await replica.restore(added.rows);
      await replica.cursors.set(BucketKey.fromJson(added.key), tick, added.generation);
    }
  }

  private async resync(models: readonly string[]): Promise<void> {
    const replica = await this.replica;
    for (const model of models) {
      await replica.removeMatching(model, {});
      await replica.cursors.forgetModel(model);
    }
    this.refreshSubscriptions();
  }

  private reportDenial(denial: TransactionEffect): void {
    if (this.denialListeners.size === 0) {
      console.warn(`Transaction ${denial.transactionId} was denied and undone: ${denial.reason ?? "no reason given"}`);
      return;
    }
    for (const listener of this.denialListeners) listener(denial);
  }

  private settle<T>(pending: Map<string, Deferred<T>>, key: string): Deferred<T> | undefined {
    const entry = pending.get(key);
    pending.delete(key);
    return entry;
  }

  private refreshSubscriptions(): void {
    for (const subscription of this.subscriptions) subscription.refresh();
  }

  // Pulls in flight are abandoned: their callers fall back to the replica.
  // Commits in flight stay pending in the log and go out again on reconnect,
  // so their promises wait. Subscriptions keep answering from the replica.
  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    this.initialSync.resolve();
    for (const pending of this.pendingPulls.values()) pending.reject(new ConnectionLost());
    this.pendingPulls.clear();
    for (const { room } of this.presenceRooms.values()) room.disconnected();
    this.scheduleReconnect();
  }
}
