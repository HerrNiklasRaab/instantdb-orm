import type { ScopedTransaction } from "./ScopedTransaction";

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

type AsyncHooksModule = {
  AsyncLocalStorage: new <T>() => AsyncLocalStorageLike<T>;
};

function tryLoadAsyncHooks(): AsyncLocalStorageLike<ScopedTransaction> | null {
  const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require;
  if (typeof nodeRequire !== "function") return null;
  try {
    const mod = nodeRequire("node:async_hooks") as AsyncHooksModule;
    return new mod.AsyncLocalStorage<ScopedTransaction>();
  } catch {
    return null;
  }
}

const asyncLocalStorage: AsyncLocalStorageLike<ScopedTransaction> | null =
  tryLoadAsyncHooks();

let globalCurrent: ScopedTransaction | null = null;

export const TransactionContext = {
  get current(): ScopedTransaction | null {
    if (asyncLocalStorage) {
      return asyncLocalStorage.getStore() ?? null;
    }
    return globalCurrent;
  },

  run<T>(tx: ScopedTransaction, fn: () => T): T {
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
  },
};
