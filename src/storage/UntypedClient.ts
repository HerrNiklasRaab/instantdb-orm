import type { ZenStackModels } from "../schema/DatabaseClient";

export type QueryArgs = Record<string, unknown>;

/** One model's ZenStack delegate, with the methods the sync engine uses and untyped arguments. */
export interface ModelDelegate {
  findMany(args: QueryArgs): Promise<unknown>;
  create(args: QueryArgs): Promise<unknown>;
  createMany(args: QueryArgs): Promise<unknown>;
  upsert(args: QueryArgs): Promise<unknown>;
  update(args: QueryArgs): Promise<unknown>;
  updateMany(args: QueryArgs): Promise<unknown>;
  deleteMany(args: QueryArgs): Promise<unknown>;
}

const DELEGATE_METHODS = ["findMany", "create", "createMany", "upsert", "update", "updateMany", "deleteMany"] as const;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isModelDelegate(value: unknown): value is ModelDelegate {
  return isObject(value) && DELEGATE_METHODS.every((method) => typeof Reflect.get(value, method) === "function");
}

export function toRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isObject(item));
}

/**
 * A ZenStack client's models, reached by a name that arrives at runtime —
 * from models, from the wire, from the WAL — which the schema-typed API
 * cannot express. Delegates are looked up and shape-checked; ZenStack still
 * validates every call against the schema.
 */
export class UntypedClient {
  constructor(private readonly raw: ZenStackModels) {}

  model(entity: string): ModelDelegate {
    const delegate: unknown = Reflect.get(this.raw, entity.charAt(0).toLowerCase() + entity.slice(1));
    if (!isModelDelegate(delegate)) {
      throw new Error(`ZenStack client has no model delegate for entity "${entity}".`);
    }
    return delegate;
  }
}
