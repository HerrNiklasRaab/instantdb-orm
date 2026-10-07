import type { ZenStackModels } from "../schema/DatabaseClient";
import type { ModelDef, SchemaDef } from "@zenstackhq/schema";
import { SyncSchema } from "../schema/SyncSchema";
import { type QueryResult, type Row } from "../queries";
import { replicaClientOf, type ReplicaClient } from "../schema/replicaClient";
import { forEachRow } from "../storage/RowStore";

/**
 * Remembers which fields the server withheld from this replica. A withheld
 * field and an empty one are both NULL in SQLite, but models must read the
 * first as `undefined` and the second as `null`.
 */
export class HiddenFields {
  private readonly models: Readonly<Record<string, ModelDef>>;
  private readonly guarded: ReadonlyMap<string, readonly string[]>;
  private readonly local: ReplicaClient;

  constructor(schema: SchemaDef, client: ZenStackModels) {
    const sync = SyncSchema.of(schema);
    this.models = sync.models;
    this.guarded = sync.guarded;
    this.local = replicaClientOf(client);
  }

  /** `row` is a whole row as the server sent it: a guarded field it lacks was withheld. */
  async record(entity: string, row: Row): Promise<void> {
    const fields = this.guarded.get(entity);
    if (!fields) return;
    await this.forget(entity, row.id);
    const withheld = fields.filter((field) => row[field] === undefined);
    if (withheld.length === 0) return;
    await this.local.hiddenFields.createMany({ data: withheld.map((field) => ({ entity, id: row.id, field })) });
  }

  async forget(entity: string, id: string): Promise<void> {
    if (!this.guarded.has(entity)) return;
    await this.local.hiddenFields.deleteMany({ where: { entity, id } });
  }

  async strip(result: QueryResult): Promise<void> {
    const rowsByKey = new Map<string, Row[]>();
    const idsByEntity = new Map<string, Set<string>>();
    forEachRow(this.models, result, (entity, row) => {
      if (!this.guarded.has(entity)) return;
      (idsByEntity.get(entity) ?? idsByEntity.set(entity, new Set()).get(entity))?.add(row.id);
      const key = `${entity}\n${row.id}`;
      rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
    });
    for (const [entity, ids] of idsByEntity) {
      const hidden = await this.local.hiddenFields.findMany({
        where: { entity, id: { in: [...ids] } },
        select: { id: true, field: true },
      });
      for (const { id, field } of hidden) {
        for (const row of rowsByKey.get(`${entity}\n${id}`) ?? []) Reflect.deleteProperty(row, field);
      }
    }
  }
}
