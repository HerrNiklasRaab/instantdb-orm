import type { DatabaseClient } from "../schema/DatabaseClient";
import { v4 as uuid } from "uuid";
import { Filing } from "./Filing";
import { logClientOf } from "../schema/logClient";
import { serverClientOf } from "../schema/serverClient";
import { toRecords } from "../storage/UntypedClient";
import { BucketLog } from "./BucketLog";
import type { SyncServer } from "./SyncServer";
import { Lsn } from "./wal/Lsn";
import { PgOutputDecoder } from "./wal/PgOutputDecoder";
import type { ReplicatedTables } from "./wal/ReplicatedTables";
import { WalCommit } from "./wal/WalCommit";

const PUBLICATION = "sync";
// Writes by the sync server read the WAL as soon as they commit; this only
// bounds how late a write by anyone else (the auth provider, a migration,
// a hand fix) is noticed.
const OUTSIDE_WRITE_INTERVAL_MS = 1000;

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isUnrefable(timer: unknown): timer is { unref(): void } {
  return typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function";
}

/**
 * Every committed write to Postgres, whoever made it, read from the WAL
 * through a logical replication slot: each commit gets the next tick, is
 * filed into its buckets and announced to the clients holding them. The tick
 * is handed out here, in commit order, so a client's bucket cursor never
 * passes a transaction that committed after a later-numbered one.
 *
 * One feed reads one slot; one server process per database runs it.
 */
export class ChangeFeed {
  private tail: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private slot = "";

  constructor(
    private readonly server: SyncServer,
    private readonly unrestricted: DatabaseClient,
    private readonly tables: ReplicatedTables,
  ) {}

  /** Checks the database is set up for it, then files whatever was committed while no feed was reading. */
  async open(): Promise<void> {
    if (this.timer) return;
    await this.requireReplicaIdentityFull();
    await this.requirePublication();
    this.slot = await this.slotName();
    await this.ensureSlot();
    await this.catchUp();
    this.timer = setInterval(() => {
      // A failed read leaves the slot where it was; the next one retries it.
      this.catchUp().catch(() => undefined);
    }, OUTSIDE_WRITE_INTERVAL_MS);
    if (isUnrefable(this.timer)) this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tail.catch(() => undefined);
  }

  /**
   * Files everything committed so far. Calls while a read is under way share
   * the one read queued after it, which sees their commits.
   */
  catchUp(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.tail.catch(() => undefined).then(() => {
      this.queued = null;
      return this.read();
    });
    this.queued = run;
    this.tail = run;
    return run;
  }

  private async read(): Promise<void> {
    const messages = (await this.query(`SELECT data FROM pg_logical_slot_peek_binary_changes('${this.slot}', NULL, NULL, 'proto_version', '1', 'publication_names', '${PUBLICATION}')`,
    )).map((row) => row.data).filter(isBytes);
    const commits = new PgOutputDecoder().decode(messages).map((wal) => new WalCommit(wal, this.tables));
    const last = commits.at(-1);
    if (!last) return;
    const filedUpTo = await this.position();
    for (const commit of commits) {
      if (filedUpTo === null || commit.commitLsn.isAfter(filedUpTo)) await this.file(commit);
    }
    await this.query(`SELECT pg_replication_slot_advance('${this.slot}', '${last.commitLsn.toString()}')`);
  }

  private async file(commit: WalCommit): Promise<void> {
    const logEntryId = commit.logEntryId();
    if (logEntryId === null && !commit.touchesSyncedRows()) return;
    const { before, after } = await commit.snapshot((entity, ids) => this.server.unrestrictedRows.columns(entity, ids));
    const entries = this.server.scheme.entriesFor(before, after);
    const transactionId = logEntryId ?? uuid();
    await this.unrestricted.$transaction(async (database) => {
      const log = logClientOf(database);
      const latest = await log.transactions.findFirst({ where: { tick: { not: null } }, orderBy: { tick: "desc" }, select: { tick: true } });
      const tick = (latest?.tick ?? 0) + 1;
      if (logEntryId === null) {
        await log.transactions.create({ data: { id: transactionId, authorId: null, status: "committed", reason: null, tick } });
      } else {
        await log.transactions.update({ where: { id: logEntryId }, data: { tick } });
      }
      await new BucketLog(database).file(tick, entries);
      await serverClientOf(database).changeFeedPosition.upsert({
        where: { slot: this.slot },
        create: { slot: this.slot, lsn: commit.commitLsn.toString() },
        update: { lsn: commit.commitLsn.toString() },
      });
    });
    const record = await this.server.unrestricted().recordOf(transactionId);
    if (!record) throw new Error(`Transaction ${transactionId} has no tick after being filed.`);
    this.server.announce(record.isDenied
      ? Filing.verdictOnly(record)
      : new Filing(record, entries, this.server.scheme.affectedIdentities(before, after)));
  }

  private async query(sql: string): Promise<Record<string, unknown>[]> {
    return toRecords(await this.unrestricted.$queryRawUnsafe(sql));
  }

  private async position(): Promise<Lsn | null> {
    const saved = await serverClientOf(this.unrestricted).changeFeedPosition.findUnique({ where: { slot: this.slot } });
    return saved ? Lsn.parse(saved.lsn) : null;
  }

  // Slot names are unique across the whole server, which may hold other databases with feeds of their own.
  private async slotName(): Promise<string> {
    const [row] = await this.query("SELECT current_database() AS name");
    const database = typeof row?.name === "string" ? row.name : "";
    return `sync_${database.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 63);
  }

  private async ensureSlot(): Promise<void> {
    const existing = await this.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name = '${this.slot}'`);
    if (existing.length > 0) return;
    await this.query(`SELECT pg_create_logical_replication_slot('${this.slot}', 'pgoutput')`);
  }

  private async requirePublication(): Promise<void> {
    const found = await this.query(`SELECT 1 FROM pg_publication WHERE pubname = '${PUBLICATION}'`);
    if (found.length === 0) {
      throw new Error(`Postgres has no publication "${PUBLICATION}"; the migration that creates it has not run.`);
    }
  }

  // Without the whole old row, an update cannot say which buckets the row left.
  private async requireReplicaIdentityFull(): Promise<void> {
    const names = this.tables.names().map((name) => `'${name}'`).join(", ");
    const partial = await this.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace `
        + `WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relreplident <> 'f' AND c.relname IN (${names})`,
    );
    if (partial.length > 0) {
      const tables = partial.map((row) => row.name).filter((name) => typeof name === "string").join(", ");
      throw new Error(`Tables without REPLICA IDENTITY FULL: ${tables}. Add it in a migration.`);
    }
  }
}
