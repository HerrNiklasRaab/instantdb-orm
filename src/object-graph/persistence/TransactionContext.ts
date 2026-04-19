import type { ScopedTransaction } from "./ScopedTransaction";

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

let asyncLocalStorage: AsyncLocalStorageLike<ScopedTransaction> | null = null;

try {
  // Use AsyncLocalStorage in Node.js for async-safe context
  const { AsyncLocalStorage } = require("node:async_hooks") as {
    AsyncLocalStorage: new <T>() => AsyncLocalStorageLike<T>;
  };
  asyncLocalStorage = new AsyncLocalStorage<ScopedTransaction>();
} catch {
  // Browser/React Native — fall back to simple global
}

let globalCurrent: ScopedTransaction | null = null;

export class TransactionContext {
  static get current(): ScopedTransaction | null {
    if (asyncLocalStorage) {
      return asyncLocalStorage.getStore() ?? null;
    }
    return globalCurrent;
  }

  static run<T>(tx: ScopedTransaction, fn: () => T): T {
    if (asyncLocalStorage) {
      return asyncLocalStorage.run(tx, fn);
    }
    const previous = globalCurrent;
    globalCurrent = tx;
    try {
      return fn();
    } finally {
      globalCurrent = previous;
    }
  }
}
