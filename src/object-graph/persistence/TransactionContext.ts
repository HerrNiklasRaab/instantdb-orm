import type { ScopedTransaction } from "./ScopedTransaction";

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

type AsyncHooksModule = {
  AsyncLocalStorage: new <T>() => AsyncLocalStorageLike<T>;
};

let asyncLocalStorage: AsyncLocalStorageLike<ScopedTransaction> | null = null;

try {
  const nodeRequire = new Function("id", "return require(id)") as (id: string) => unknown;
  const { AsyncLocalStorage } = nodeRequire("node:async_hooks") as AsyncHooksModule;
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
