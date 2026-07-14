import {
  ScopedTransaction,
  TransactionContext,
} from "./object-graph";
import type { AnySchema } from "./instantdb";
import type { TransactionStoreAccess } from "./object-graph/persistence/ScopedTransaction";

/**
 * Opens a ScopedTransaction for the duration of `fn` so unit tests can
 * mutate observed properties without hitting the tx-only enforcement on
 * Model. The tx never commits or rolls back — its only purpose is to
 * satisfy `claimForCurrentTransaction`.
 *
 * Use only in low-level unit tests that don't have a RootStore. Integration
 * tests should drive mutations through `store.transaction(...)`.
 */
const emptyTx: TransactionStoreAccess<AnySchema>["db"]["tx"] = {};

const stubStore: TransactionStoreAccess<AnySchema> = {
  db: {
    tx: emptyTx,
    transact: () => Promise.resolve(),
  },
  getIdentityMapByName: () => ({
    has: () => false,
    set: () => undefined,
    delete: () => false,
  }),
  rehydrateModel: () => undefined,
  evictModel: () => undefined,
};

export function withTestTransaction<T>(fn: () => Promise<T>): Promise<T>;
export function withTestTransaction<T>(fn: () => T): T;
export function withTestTransaction<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const tx = new ScopedTransaction<AnySchema>(stubStore);
  let result: T | Promise<T>;
  try {
    result = TransactionContext.run(tx, fn);
  } catch (err) {
    tx.dispose();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => { tx.dispose(); });
  }
  tx.dispose();
  return result;
}
