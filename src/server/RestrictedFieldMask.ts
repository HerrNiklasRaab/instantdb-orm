import type { ZenStackModels } from "../schema/DatabaseClient";
import type { ModelDef, SchemaDef } from "@zenstackhq/schema";
import { SyncSchema } from "../schema/SyncSchema";
import { type QueryResult, type Row } from "../queries";
import { forEachRow } from "../storage/RowStore";
import { toRecords, UntypedClient } from "../storage/UntypedClient";

/**
 * ZenStack answers a field-level read denial with `null`, but the sync layer
 * reads "not returned" as `undefined` and a real `null` as a cleared value.
 * Rows whose guarded fields came back null are re-checked with the
 * unrestricted client; a field that is set there was hidden, so it is dropped.
 */
export class RestrictedFieldMask {
  private readonly models: Readonly<Record<string, ModelDef>>;
  private readonly guarded: ReadonlyMap<string, readonly string[]>;

  private readonly unrestricted: UntypedClient;

  constructor(schema: SchemaDef, unrestricted: ZenStackModels) {
    this.unrestricted = new UntypedClient(unrestricted);
    const sync = SyncSchema.of(schema);
    this.models = sync.models;
    this.guarded = sync.guarded;
  }

  async apply(result: QueryResult): Promise<void> {
    if (this.guarded.size === 0) return;
    const suspects = new Map<string, Map<string, Row[]>>();
    forEachRow(this.models, result, (entity, row) => {
      const fields = this.guarded.get(entity);
      if (!fields?.some((field) => row[field] === null)) return;
      const rowsById = suspects.get(entity) ?? new Map<string, Row[]>();
      suspects.set(entity, rowsById);
      rowsById.set(row.id, [...(rowsById.get(row.id) ?? []), row]);
    });
    for (const [entity, rowsById] of suspects) {
      await this.dropHidden(entity, rowsById);
    }
  }

  private async dropHidden(entity: string, rowsById: Map<string, Row[]>): Promise<void> {
    const fields = this.guarded.get(entity) ?? [];
    const select: Record<string, boolean> = { id: true };
    for (const field of fields) select[field] = true;
    const actual = toRecords(
      await this.unrestricted.model(entity).findMany({ where: { id: { in: [...rowsById.keys()] } }, select }),
    );
    for (const stored of actual) {
      const rows = typeof stored.id === "string" ? rowsById.get(stored.id) : undefined;
      if (!rows) continue;
      for (const field of fields) {
        if (stored[field] === null || stored[field] === undefined) continue;
        for (const row of rows) {
          if (row[field] === null) Reflect.deleteProperty(row, field);
        }
      }
    }
  }
}
