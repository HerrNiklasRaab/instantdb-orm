import type { FindManyArgs } from "@zenstackhq/orm";
import type { GetModels, SchemaDef } from "@zenstackhq/schema";

export interface Row {
  id: string;
  [column: string]: unknown;
}

export type QueryResult = Record<string, Row[]>;

/** Model name → ZenStack's own `findMany` arguments for that model. */
export type SyncQuery<Schema extends SchemaDef> = {
  [Model in GetModels<Schema>]?: FindManyArgs<Schema, Model>;
};

/**
 * A query whose models are only known by name at runtime: on the wire, and
 * while the store rewrites it. ZenStack's argument types need a concrete
 * schema, so this form is deliberately loose; the server's ZenStack client
 * validates the arguments when it runs them.
 */
export type UntypedQuery = Record<string, Record<string, unknown>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function untypedQuery(query: object): UntypedQuery {
  const untyped: UntypedQuery = {};
  for (const [model, args] of Object.entries(query)) {
    if (isRecord(args)) untyped[model] = args;
  }
  return untyped;
}
