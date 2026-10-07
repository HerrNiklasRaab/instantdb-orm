import type { ModelDef, SchemaDef } from "@zenstackhq/schema";
import { isRecord } from "../queries/SyncQuery";
import { ModelLinks } from "./ModelLinks";

function literalOf(expression: unknown): unknown {
  return isRecord(expression) ? expression.value : undefined;
}

/**
 * `@@meta('sync', 'internal')` in ZModel marks sync bookkeeping (the log,
 * the replica's own tables). Everything else is an entity clients query,
 * write and replicate.
 */
function isInternal(model: ModelDef): boolean {
  return (model.attributes ?? []).some((attribute) =>
    attribute.name === "@@meta"
    && literalOf(attribute.args?.[0]?.value) === "sync"
    && literalOf(attribute.args?.[1]?.value) === "internal");
}

/** An app's generated ZenStack schema, as the sync engine reads it. */
export class SyncSchema {
  /** The models clients may query, write and replicate. */
  readonly models: Readonly<Record<string, ModelDef>>;
  /** Per model, the fields carrying their own read policy (`@allow` / `@deny`): what the server may withhold. */
  readonly guarded: ReadonlyMap<string, readonly string[]>;

  private constructor(readonly def: SchemaDef) {
    const models: Record<string, ModelDef> = {};
    const guarded = new Map<string, string[]>();
    for (const [name, model] of Object.entries(def.models)) {
      if (isInternal(model)) continue;
      models[name] = model;
      const fields = Object.values(model.fields)
        .filter((field) => field.attributes?.some((a) => a.name === "@allow" || a.name === "@deny"))
        .map((field) => field.name);
      if (fields.length > 0) guarded.set(name, fields);
    }
    this.models = models;
    this.guarded = guarded;
  }

  static of(def: SchemaDef): SyncSchema {
    return new SyncSchema(def);
  }

  has(entity: string): boolean {
    return entity in this.models;
  }

  model(entity: string): ModelDef {
    const model = this.models[entity];
    if (!model) throw new Error(`"${entity}" is not a synced entity.`);
    return model;
  }

  links(entity: string): ModelLinks {
    return new ModelLinks(entity, this.models);
  }
}
