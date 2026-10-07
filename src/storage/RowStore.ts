import type { ZenStackModels } from "../schema/DatabaseClient";
import { DbNull } from "@zenstackhq/orm";
import type { ModelDef, SchemaDef } from "@zenstackhq/schema";
import type { ModelLinks } from "../schema/ModelLinks";
import { SyncSchema } from "../schema/SyncSchema";
import { type QueryResult, type Row, type UntypedQuery, isRecord } from "../queries";
import { type Change, type ChangeOf, type Transaction } from "../transactions";
import { Temporal } from "../object-graph/temporal";
import { ManyToManyLink } from "./ManyToManyLink";
import { toRecords, UntypedClient } from "./UntypedClient";

/** A change the database refused, with the change attached so the server can say why. */
export class ChangeRejected extends Error {
  constructor(
    readonly change: Change,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function isRow(value: unknown): value is Row {
  return isRecord(value) && typeof value.id === "string";
}

// ZenStack rejects a bare `null` for Json columns; SQL NULL must be DbNull.
// Values are untyped because rows the server sent are stored through here
// too; ZenStack validates them against the schema.
export function columnInput(model: ModelDef, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(values)) {
    input[column] = value === null && model.fields[column]?.type === "Json" ? DbNull : value;
  }
  return input;
}

/**
 * Synced rows behind one ZenStack client — Postgres on the server, SQLite on
 * a device. Reads come back in the sync row shape: canonical ISO strings for
 * DateTime, relations nested under their field, foreign-key columns hidden
 * (the relation field carries the link).
 */
export class RowStore {
  private readonly schema: SyncSchema;
  private readonly db: UntypedClient;

  constructor(schema: SchemaDef, client: ZenStackModels) {
    this.schema = SyncSchema.of(schema);
    this.db = new UntypedClient(client);
  }

  async read(query: UntypedQuery): Promise<QueryResult> {
    const result: QueryResult = {};
    for (const [entity, args] of Object.entries(query)) {
      this.model(entity);
      const rows = await this.db.model(entity).findMany({ ...args });
      result[entity] = this.shapeRows(entity, toRecords(rows));
    }
    return result;
  }

  /** Whole rows — every column, every link as ids — the unit clients replicate. */
  readWhole(entity: string, ids: readonly string[]): Promise<Row[]> {
    return this.readMatching(entity, { id: { in: [...ids] } });
  }

  /** Whole rows of everything that matches `where`: how a bucket's contents are read. */
  async readMatching(entity: string, where: Record<string, unknown>): Promise<Row[]> {
    const include: Record<string, unknown> = {};
    for (const field of Object.values(this.model(entity).fields)) {
      if (field.relation) include[field.name] = { select: { id: true } };
    }
    const result = await this.read({ [entity]: { where, include } });
    return result[entity] ?? [];
  }

  /** The stored columns of these rows, foreign keys included and nothing shaped: what bucket keys are computed from. */
  async columns(entity: string, ids: readonly string[]): Promise<Map<string, Row>> {
    this.model(entity);
    const rows = await this.db.model(entity).findMany({ where: { id: { in: [...ids] } } });
    const byId = new Map<string, Row>();
    for (const row of toRecords(rows)) {
      if (isRow(row)) byId.set(row.id, row);
    }
    return byId;
  }

  /**
   * Applies a transaction's changes: new rows with the links they hold, in
   * the order listed — a row linking to another new row must come after it,
   * or the insert is refused — then updates, then many-to-many links, then
   * deletes. Atomic only when this store wraps a transaction client.
   */
  async write(transaction: Transaction): Promise<void> {
    // createMany, not create: create reads the row back under the read policy,
    // and a row whose visibility hangs on a row inserted after it is not
    // readable yet.
    for (const change of transaction.ofKind("create")) {
      await this.attempt(change, async () => {
        const links = this.schema.links(change.entity);
        await this.releaseOneToOneTargets(links, change);
        await this.db.model(change.entity).createMany({
          data: [{ ...columnInput(this.model(change.entity), change.values), ...links.foreignKeys(change.links ?? {}), id: change.id }],
        });
      });
    }
    for (const change of transaction.ofKind("update")) {
      await this.attempt(change, async () => {
        const links = this.schema.links(change.entity);
        await this.releaseOneToOneTargets(links, change);
        await this.db.model(change.entity).update({
          where: { id: change.id },
          data: { ...columnInput(this.model(change.entity), change.values), ...links.foreignKeys(change.links ?? {}) },
        });
      });
    }
    for (const change of transaction.ofKind("unlink")) {
      await this.attempt(change, () => this.manyToMany(change).unlink(this.db, change.id, change.targetIds));
    }
    for (const change of transaction.ofKind("link")) {
      await this.attempt(change, () => this.manyToMany(change).link(this.db, change.id, change.targetIds));
    }
    for (const change of transaction.ofKind("delete")) {
      this.model(change.entity);
      await this.attempt(change, () => this.db.model(change.entity).deleteMany({ where: { id: change.id } }));
    }
  }

  /** Whether a row exists at all — asked of an unrestricted store to tell "forbidden" from "missing". */
  async exists(entity: string, id: string): Promise<boolean> {
    const rows = await this.db.model(entity).findMany({ where: { id }, select: { id: true } });
    return toRecords(rows).length > 0;
  }

  private async attempt(change: Change, apply: () => Promise<unknown>): Promise<void> {
    try {
      await apply();
    } catch (error) {
      throw new ChangeRejected(change, error);
    }
  }

  /** Before a row takes a one-to-one target, any other row holding it lets go. */
  private async releaseOneToOneTargets(links: ModelLinks, change: ChangeOf<"create"> | ChangeOf<"update">): Promise<void> {
    for (const [field, target] of Object.entries(change.links ?? {})) {
      const column = links.columnOf(field);
      if (target === null || column === null || !links.isOneToOne(field)) continue;
      await this.db.model(change.entity).updateMany({
        where: { [column]: target, NOT: { id: change.id } },
        data: { [column]: null },
      });
    }
  }

  private manyToMany(change: ChangeOf<"link"> | ChangeOf<"unlink">): ManyToManyLink {
    if (!this.schema.links(change.entity).isManyToMany(change.field)) {
      throw new Error(`"${change.entity}.${change.field}" is not many-to-many; a row's own link travels with its create or update.`);
    }
    return new ManyToManyLink(change.entity, change.field);
  }

  model(entity: string): ModelDef {
    return this.schema.model(entity);
  }

  private shapeRows(entity: string, rows: Record<string, unknown>[]): Row[] {
    const shaped: Row[] = [];
    for (const row of rows) {
      const one = this.shapeRow(entity, row);
      if (one) shaped.push(one);
    }
    return shaped;
  }

  private shapeRow(entity: string, row: Record<string, unknown>): Row | null {
    const id = row.id;
    const model = this.schema.models[entity];
    if (typeof id !== "string" || !model) return null;
    const shaped: Row = { id };
    for (const [key, value] of Object.entries(row)) {
      if (key === "id") continue;
      const field = model.fields[key];
      if (field?.foreignKeyFor) continue;
      if (field?.relation) {
        shaped[key] = this.shapeRelation(field.type, value);
      } else {
        shaped[key] = value instanceof Date ? Temporal.Instant.fromEpochMilliseconds(value.getTime()).toString() : value;
      }
    }
    return shaped;
  }

  private shapeRelation(entity: string, value: unknown): Row[] | Row | null {
    if (Array.isArray(value)) return this.shapeRows(entity, toRecords(value));
    return isRecord(value) ? this.shapeRow(entity, value) : null;
  }
}

/** Visits every row in a result, including rows nested under relation fields. */
export function forEachRow(
  models: Record<string, ModelDef>,
  result: QueryResult,
  visit: (entity: string, row: Row) => void,
): void {
  const walk = (entity: string, row: Row): void => {
    const model = models[entity];
    if (!model) return;
    visit(entity, row);
    for (const [key, value] of Object.entries(row)) {
      const field = model.fields[key];
      if (!field?.relation) continue;
      for (const nested of Array.isArray(value) ? value : [value]) {
        if (isRow(nested)) walk(field.type, nested);
      }
    }
  };
  for (const [entity, rows] of Object.entries(result)) {
    for (const row of rows) walk(entity, row);
  }
}
