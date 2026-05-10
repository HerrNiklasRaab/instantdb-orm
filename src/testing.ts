import {
  ScopedTransaction,
  TransactionContext,
} from "./object-graph";
import type { TransactionStoreAccess } from "./object-graph/persistence/ScopedTransaction";

/**
 * Opens a ScopedTransaction for the duration of `fn` so unit tests can
 * mutate observed properties without hitting the tx-only enforcement in
 * ChangeTracker. The tx never commits or rolls back — its only purpose is
 * to satisfy `claimForCurrentTransaction`.
 *
 * Use only in low-level unit tests that don't have a RootStore. Integration
 * tests should drive mutations through `store.transaction(...)`.
 */
const stubStore: TransactionStoreAccess = {
  db: {
    tx: {} as Record<string, Record<string, unknown>> as TransactionStoreAccess["db"]["tx"],
    transact: async () => undefined,
  },
  getIdentityMapByName: () => ({
    has: () => false,
    set: () => undefined,
    delete: () => false,
  }),
  getLinkLabel: (_entityName, linkName) => linkName,
  rehydrateModel: () => undefined,
};

export function withTestTransaction<T>(fn: () => T): T {
  const tx = new ScopedTransaction(stubStore);
  return TransactionContext.run(tx, fn);
}
