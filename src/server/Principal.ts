import type { DatabaseClient, ZenStackModels } from "../schema/DatabaseClient";
import { ORMError, ORMErrorReason } from "@zenstackhq/orm";
import type { SchemaDef } from "@zenstackhq/schema";
import type { BucketKey } from "../buckets/BucketKey";
import type { TouchedRows } from "../buckets/TouchedRows";
import { type QueryResult, type Row, type UntypedQuery } from "../queries";
import { type Transaction, type TransactionEffect, type TransactionStatus } from "../transactions";
import { logClientOf, type LogClient } from "../schema/logClient";
import { ChangeRejected, RowStore } from "../storage/RowStore";
import type { SyncServer } from "./SyncServer";
import { TransactionRecord } from "./TransactionRecord";

/** Rows as one identity may see them, and the ids it must drop because it may not. */
export class VisibleRows {
  constructor(
    readonly rows: QueryResult,
    readonly removed: Record<string, string[]>,
  ) {}
}

/**
 * Who acts on the data, and with what rights: pulls, commits and bucket
 * contents run under this identity's policies. Holds no connection state; a
 * `ClientConnection` acts through one. Never used as a client itself.
 */
export class Principal<Schema extends SchemaDef = SchemaDef> {
  private readonly rows: RowStore;
  private readonly log: LogClient;

  constructor(
    readonly schema: Schema,
    private readonly client: DatabaseClient,
    readonly authorId: string | null,
    private readonly server: SyncServer<Schema>,
  ) {
    this.rows = new RowStore(schema, client);
    this.log = logClientOf(server.unrestrictedClient);
  }

  /** Server-side code with no identity: sees everything, holds every bucket. */
  get isUnrestricted(): boolean {
    return this.client === this.server.unrestrictedClient;
  }

  async query(query: UntypedQuery): Promise<QueryResult> {
    const result = await this.rows.read(query);
    await this.maskFor(result);
    return result;
  }

  /**
   * Applies the transaction and logs it as `committed` in one database
   * transaction, so the log and the data can never disagree. A transaction
   * the database refuses is applied nowhere but still logged, as `denied`
   * with the reason. Either way the change feed then reads it from the WAL,
   * gives it its tick and announces it, to its author too.
   */
  async write(transaction: Transaction): Promise<void> {
    try {
      await this.client.$transaction(async (databaseTransaction) => {
        await new RowStore(this.schema, databaseTransaction).write(transaction);
        await this.append(databaseTransaction, transaction, "committed", null);
      });
    } catch (error) {
      if (!(error instanceof ChangeRejected)) throw error;
      const reason = await this.explain(error);
      await this.client.$transaction((databaseTransaction) => this.append(databaseTransaction, transaction, "denied", reason));
    }
    await this.server.feed.catchUp();
  }

  /** Whether the log holds this transaction at all, ticked or not yet. */
  async hasLogged(transactionId: string): Promise<boolean> {
    return (await this.log.transactions.count({ where: { id: transactionId } })) > 0;
  }

  /** The log entry for a transaction id, if the server has one. */
  async recordOf(transactionId: string): Promise<TransactionRecord | null> {
    const entry = await this.log.transactions.findUnique({
      where: { id: transactionId },
      include: { changes: { orderBy: { position: "asc" } } },
    });
    return entry ? TransactionRecord.fromLogEntry(entry) : null;
  }

  /** Whether this identity's read policy lets it see the row: what being in the row's presence room takes. */
  async canRead(entity: string, id: string): Promise<boolean> {
    if (!this.server.scheme.has(entity)) return false;
    return (await this.rows.readWhole(entity, [id])).length > 0;
  }

  async currentTick(): Promise<number> {
    const latest = await this.log.transactions.findFirst({ orderBy: { tick: "desc" }, select: { tick: true } });
    return latest?.tick ?? 0;
  }

  /**
   * What one of this identity's own transactions comes to: the verdict, and
   * every row it touched as the server has it now. A denied transaction
   * touched nothing on the server, so those rows are exactly the undo.
   */
  async effectOf(record: TransactionRecord): Promise<TransactionEffect> {
    const visible = await this.visibleRows(record.transaction.touchedRows(this.schema.models));
    return { ...record.outcome(), tick: record.tick, status: record.status, rows: visible.rows, removed: visible.removed };
  }

  /** The rows behind bucket entries, as this identity may see them; rows the entries removed are gone either way. */
  async changedRows(touched: TouchedRows): Promise<VisibleRows> {
    const visible = await this.visibleRows(touched.present);
    for (const [entity, ids] of touched.removed) {
      visible.removed[entity] = [...new Set([...visible.removed[entity] ?? [], ...ids])];
    }
    return visible;
  }

  /** Everything in one bucket, as this identity may see it. */
  async bucketRows(key: BucketKey): Promise<Row[]> {
    const result: QueryResult = { [key.model]: await this.rows.readMatching(key.model, key.filter()) };
    await this.maskFor(result);
    return result[key.model] ?? [];
  }

  // A touched row that does not come back was deleted or is not visible to
  // this identity; either way its replica must drop it.
  private async visibleRows(wanted: ReadonlyMap<string, ReadonlySet<string>>): Promise<VisibleRows> {
    const rows: QueryResult = {};
    const removed: Record<string, string[]> = {};
    for (const [entity, ids] of wanted) {
      const visible = await this.rows.readWhole(entity, [...ids]);
      rows[entity] = visible;
      const visibleIds = new Set(visible.map((row) => row.id));
      const gone = [...ids].filter((id) => !visibleIds.has(id));
      if (gone.length > 0) removed[entity] = gone;
    }
    await this.maskFor(rows);
    return new VisibleRows(rows, removed);
  }

  // The service principal sees everything; every other one has fields withheld.
  private async maskFor(result: QueryResult): Promise<void> {
    if (!this.isUnrestricted) await this.server.mask.apply(result);
  }

  private async append(
    databaseTransaction: ZenStackModels,
    transaction: Transaction,
    status: TransactionStatus,
    reason: string | null,
  ): Promise<void> {
    const log = logClientOf(databaseTransaction);
    await log.transactions.createMany({ data: [{ id: transaction.id, authorId: this.authorId, status, reason }] });
    await log.changes.createMany({ data: transaction.toLogRows() });
  }

  // Policies act as filters, so a row this identity may not touch reads as
  // missing. An unrestricted look tells the two apart; the author should
  // hear "not allowed" when that is what happened.
  private async explain({ change, cause, message }: ChangeRejected): Promise<string> {
    if (!(cause instanceof ORMError) || cause.reason !== ORMErrorReason.NOT_FOUND) return message;
    if (!(await this.server.unrestrictedRows.exists(change.entity, change.id))) return message;
    return `${change.kind} of ${change.entity} ${change.id} is rejected by access policies`;
  }
}
