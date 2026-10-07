import type { SchemaDef } from "@zenstackhq/schema";
import { SyncSchema } from "../schema/SyncSchema";
import { type Row } from "../queries";
import type { BucketKey } from "./BucketKey";
import { ConditionCompiler } from "./ConditionCompiler";
import type { BucketEntry } from "./BucketEntry";
import { ModelScheme } from "./ModelScheme";
import type { ParameterQueries } from "./ParameterQueries";

export type { BucketRule, ColumnKey, ParameterQuery } from "./BucketRule";
export { ModelScheme } from "./ModelScheme";

/** The rows of each touched entity as they were at one moment, by id. */
export type RowSnapshot = ReadonlyMap<string, ReadonlyMap<string, Row>>;

/** How every model's rows are filed into buckets, compiled from the schema's read policies. */
export class BucketScheme {
  private constructor(private readonly models: ReadonlyMap<string, ModelScheme>) {}

  static compile(schema: SchemaDef): BucketScheme {
    const models = new Map<string, ModelScheme>();
    for (const model of Object.keys(SyncSchema.of(schema).models)) {
      models.set(model, new ModelScheme(model, new ConditionCompiler(schema, model).compileModel()));
    }
    return new BucketScheme(models);
  }

  has(model: string): boolean {
    return this.models.has(model);
  }

  of(model: string): ModelScheme {
    const scheme = this.models.get(model);
    if (!scheme) throw new Error(`No model ${model} in the schema`);
    return scheme;
  }

  modelNames(): string[] {
    return [...this.models.keys()];
  }

  generations(): Record<string, string> {
    return Object.fromEntries([...this.models].map(([model, scheme]) => [model, scheme.generation]));
  }

  async heldKeys(identityId: string | null, queries: ParameterQueries): Promise<BucketKey[]> {
    const keys: BucketKey[] = [];
    for (const scheme of this.models.values()) keys.push(...await scheme.heldKeys(identityId, queries));
    return keys;
  }

  /** The bucket entries of a transaction, from the touched rows before and after it. */
  entriesFor(before: RowSnapshot, after: RowSnapshot): BucketEntry[] {
    const entries: BucketEntry[] = [];
    for (const entity of new Set([...before.keys(), ...after.keys()])) {
      const scheme = this.models.get(entity);
      if (!scheme) continue;
      const ids = new Set([...before.get(entity)?.keys() ?? [], ...after.get(entity)?.keys() ?? []]);
      for (const id of ids) entries.push(...scheme.entriesFor(id, before.get(entity)?.get(id), after.get(entity)?.get(id)));
    }
    return entries;
  }

  /** Whose held keys the touched rows may have changed: the identities those rows name. */
  affectedIdentities(before: RowSnapshot, after: RowSnapshot): Set<string> {
    const identities = new Set<string>();
    for (const entity of new Set([...before.keys(), ...after.keys()])) {
      const rows = [...before.get(entity)?.values() ?? [], ...after.get(entity)?.values() ?? []];
      for (const scheme of this.models.values()) {
        for (const identity of scheme.identitiesNamedBy(entity, rows)) identities.add(identity);
      }
    }
    return identities;
  }
}
