import { ZenStackClient, type ClientOptions } from "@zenstackhq/orm";
import type { SchemaDef } from "@zenstackhq/schema";
import { SyncSchema } from "../schema/SyncSchema";
import { type Change, type Transaction, type TransactionEffect } from "../transactions";
import { type QueryResult, type Row, type UntypedQuery } from "../queries";
import { JoinTable } from "../storage/JoinTable";
import { RowStore, columnInput, isRow } from "../storage/RowStore";
import { toRecords, UntypedClient } from "../storage/UntypedClient";
import type { DatabaseClient } from "../schema/DatabaseClient";
import { BucketCursors } from "./BucketCursors";
import { HiddenFields } from "./HiddenFields";
import { LocalLog } from "./LocalLog";
import { ReplicaSchema } from "./ReplicaSchema";

type SqliteDialect = ClientOptions<SchemaDef>["dialect"];

/** How far a row's many-to-many links may be trusted when it is stored. */
enum LinkAuthority {
  /** A whole row from a transaction effect: its link lists are complete. */
  Complete,
  /** A row from a pulled query, whose nested lists may be filtered: only add. */
  Partial,
}

function isStub(row: Row): boolean {
  return Object.keys(row).every((key) => key === "id");
}

/**
 * This device's copy of the rows the server has let it see, in SQLite, plus
 * this device's own transactions the server has not answered yet, applied
 * on top. Confirmed rows enter through pulled queries and through the effects
 * of committed transactions. Its tables follow `ReplicaSchema`.
 */
export class LocalReplica {
  private constructor(
    private readonly schema: SyncSchema,
    private readonly client: DatabaseClient,
    private readonly db: UntypedClient,
    private readonly rows: RowStore,
    private readonly hidden: HiddenFields,
    readonly log: LocalLog,
    readonly cursors: BucketCursors,
  ) {}

  static async open(schema: SchemaDef, dialect: SqliteDialect): Promise<LocalReplica> {
    const sync = SyncSchema.of(schema);
    const local = ReplicaSchema.of(schema).def;
    const client = new ZenStackClient(local, { dialect });
    await client.$pushSchema();
    for (const table of JoinTable.all(sync.models)) await table.ensure(client);
    return new LocalReplica(sync, client, new UntypedClient(client), new RowStore(local, client), new HiddenFields(local, client), new LocalLog(client), new BucketCursors(client));
  }

  async read(query: UntypedQuery): Promise<QueryResult> {
    const result = await this.rows.read(query);
    await this.hidden.strip(result);
    return result;
  }

  /** A query's answer: rows as the server had them, link lists possibly partial. */
  async absorb(pulled: QueryResult): Promise<void> {
    for (const [entity, rows] of Object.entries(pulled)) {
      for (const row of rows) await this.store(entity, row, LinkAuthority.Partial);
    }
  }

  /**
   * Applies this client's unconfirmed transactions again, on top of whatever
   * the server just wrote: its rows may predate them, and the replica reads as
   * the server's state plus what this client has not heard back on.
   */
  async rebase(): Promise<void> {
    for (const transaction of await this.log.pending()) await this.applyOwn(transaction);
  }

  async apply(effect: TransactionEffect): Promise<void> {
    await this.restore(effect.rows);
    for (const [entity, ids] of Object.entries(effect.removed)) await this.remove(entity, ids);
  }

  /** Whole rows straight from the server, link lists complete. */
  async restore(rows: QueryResult): Promise<void> {
    for (const [entity, entityRows] of Object.entries(rows)) {
      for (const row of entityRows) await this.store(entity, row, LinkAuthority.Complete);
    }
  }

  async remove(entity: string, ids: readonly string[]): Promise<void> {
    if (!this.schema.models[entity] || ids.length === 0) return;
    await this.db.model(entity).deleteMany({ where: { id: { in: [...ids] } } });
    for (const id of ids) await this.hidden.forget(entity, id);
  }

  /** Drops a bucket's rows: everything of `entity` that matches `filter`, all of it when the filter is empty. */
  async removeMatching(entity: string, filter: Record<string, unknown>): Promise<void> {
    if (!this.schema.models[entity]) return;
    const rows = await this.db.model(entity).findMany({ where: filter, select: { id: true } });
    await this.remove(entity, toRecords(rows).flatMap((row) => (isRow(row) ? [row.id] : [])));
  }

  /**
   * One of this device's own transactions, applied before the server has
   * seen it. Lenient where the server is strict: a row the replica never
   * received is skipped rather than refused, and no field-visibility is
   * recorded, since nothing here came from the server.
   */
  async applyOwn(transaction: Transaction): Promise<void> {
    for (const change of transaction.changes) await this.applyChange(change);
  }

  private async applyChange(change: Change): Promise<void> {
    const model = this.schema.models[change.entity];
    if (!model) return;
    const delegate = this.db.model(change.entity);
    switch (change.kind) {
      case "create": {
        const data = { ...columnInput(model, change.values), ...this.schema.links(change.entity).foreignKeys(change.links ?? {}) };
        await delegate.upsert({ where: { id: change.id }, create: { ...data, id: change.id }, update: data });
        return;
      }
      case "update":
        await delegate.updateMany({
          where: { id: change.id },
          data: { ...columnInput(model, change.values), ...this.schema.links(change.entity).foreignKeys(change.links ?? {}) },
        });
        return;
      case "delete":
        await this.remove(change.entity, [change.id]);
        return;
      case "link":
      case "unlink":
        await this.applyLink(change);
        return;
    }
  }

  private async applyLink(change: Extract<Change, { field: string }>): Promise<void> {
    const table = JoinTable.of(this.schema.models, change.entity, change.field);
    if (!table) return;
    for (const targetId of change.targetIds) {
      await (change.kind === "link" ? table.add(this.client, change.id, targetId) : table.remove(this.client, change.id, targetId));
    }
  }

  private async store(entity: string, row: Row, authority: LinkAuthority): Promise<void> {
    const model = this.schema.models[entity];
    if (!model || isStub(row)) return;

    const links = this.schema.links(entity);
    const columns: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(model.fields)) {
      const value = row[name];
      if (name === "id" || value === undefined || field.foreignKeyFor || field.computed) continue;
      if (!field.relation) {
        columns[name] = value;
        continue;
      }
      const foreignKey = links.columnOf(name);
      if (foreignKey !== null) columns[foreignKey] = isRow(value) ? value.id : null;
      for (const nested of Array.isArray(value) ? value : [value]) {
        if (isRow(nested)) await this.store(field.type, nested, authority);
      }
    }

    const data = columnInput(model, columns);
    await this.db.model(entity).upsert({ where: { id: row.id }, create: { ...data, id: row.id }, update: data });
    await this.storeJoinRows(entity, row, authority);
    await this.hidden.record(entity, row);
  }

  private async storeJoinRows(entity: string, row: Row, authority: LinkAuthority): Promise<void> {
    for (const [name, value] of Object.entries(row)) {
      const table = JoinTable.of(this.schema.models, entity, name);
      if (!table || !Array.isArray(value)) continue;
      if (authority === LinkAuthority.Complete) await table.clear(this.client, row.id);
      for (const linked of value) {
        if (isRow(linked)) await table.add(this.client, row.id, linked.id);
      }
    }
  }
}
