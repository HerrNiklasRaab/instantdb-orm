import type { ColumnValue } from "../../object-graph/columns/types";
import { decodeColumnValue } from "../../protocol";
import type { ModelDef, SchemaDef } from "@zenstackhq/schema";
import { SyncSchema } from "../../schema/SyncSchema";
import { type Row } from "../../queries";
import { JoinTable } from "../../storage/JoinTable";
import type { TextTuple } from "./PgOutputDecoder";

const NUMERIC_TYPES = new Set(["Int", "Float", "Decimal", "BigInt"]);

/**
 * The tables behind the synced models, as the WAL names them: an entity's
 * own table, or the join table of an implicit many-to-many relation. Turns
 * WAL text back into the column values the bucket rules key on.
 */
export class ReplicatedTables {
  private constructor(
    private readonly schema: SyncSchema,
    private readonly joins: ReadonlyMap<string, JoinTable>,
  ) {}

  static of(schema: SchemaDef): ReplicatedTables {
    const sync = SyncSchema.of(schema);
    return new ReplicatedTables(sync, new Map(JoinTable.all(sync.models).map((join) => [join.name, join])));
  }

  /** Every table whose changes the feed must see with their old values. */
  names(): string[] {
    return [...Object.keys(this.schema.models), ...this.joins.keys()];
  }

  isEntity(table: string): boolean {
    return this.schema.has(table);
  }

  joinTable(table: string): JoinTable | null {
    return this.joins.get(table) ?? null;
  }

  model(entity: string): ModelDef {
    return this.schema.model(entity);
  }

  row(entity: string, tuple: TextTuple): Row {
    const model = this.model(entity);
    const id = tuple.id;
    if (typeof id !== "string") throw new Error(`A ${entity} row arrived from the WAL without an id.`);
    const row: Row = { id };
    for (const [column, text] of Object.entries(tuple)) {
      if (column !== "id") row[column] = this.value(model.fields[column]?.type, text);
    }
    return row;
  }

  /** The rows a write linked or unlinked through a foreign key: both ends of every key it changed. */
  relinked(entity: string, before: Row | null, after: Row | null): { entity: string; id: string }[] {
    const relinked: { entity: string; id: string }[] = [];
    for (const link of this.schema.links(entity).held()) {
      const was = before?.[link.column];
      const is = after?.[link.column];
      if (was === is) continue;
      for (const id of [was, is]) {
        if (typeof id === "string") relinked.push({ entity: link.target, id });
      }
    }
    return relinked;
  }

  private value(type: string | undefined, text: string | null): ColumnValue {
    if (text === null) return null;
    if (type === "Boolean") return text === "t";
    if (type !== undefined && NUMERIC_TYPES.has(type)) return Number(text);
    if (type === "Json") return decodeColumnValue(JSON.parse(text));
    return text;
  }
}
