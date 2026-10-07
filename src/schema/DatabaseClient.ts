/**
 * The client ZenStack hands to work inside a transaction, or any client used
 * only through its models. Its models are named at runtime, so they are
 * reached by name (`UntypedClient`) or through a checked view of the
 * engine's own tables (`logClientOf`, `serverClientOf`, `replicaClientOf`).
 * For a schema not known at compile time ZenStack's transaction type keeps
 * nothing else TypeScript could name.
 */
export type ZenStackModels = object;

/**
 * What the sync engine needs from a whole ZenStack client, whatever its
 * schema: raw SQL and transactions. ZenStack's own `ClientContract<Schema>`
 * is tied to one schema and does not accept another app's client; this does.
 */
export interface DatabaseClient {
  $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(work: (tx: ZenStackModels) => Promise<T>): Promise<T>;
}
