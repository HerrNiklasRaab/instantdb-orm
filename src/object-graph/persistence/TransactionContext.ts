import type { ScopedTransaction } from "./ScopedTransaction";

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

function isRequire(value: unknown): value is (id: string) => unknown {
  return typeof value === "function";
}

function isAsyncLocalStorageLike(
  value: unknown
): value is AsyncLocalStorageLike<ScopedTransaction> {
  if (value === null || typeof value !== "object") return false;
  const getStore: unknown = Reflect.get(value, "getStore");
  const run: unknown = Reflect.get(value, "run");
  return typeof getStore === "function" && typeof run === "function";
}

function tryLoadAsyncHooks(): AsyncLocalStorageLike<ScopedTransaction> | null {
  const requireRef: unknown = Reflect.get(globalThis, "require");
  if (!isRequire(requireRef)) return null;
  try {
    const mod: unknown = requireRef("node:async_hooks");
    if (mod === null || typeof mod !== "object") return null;
    const ctor: unknown = Reflect.get(mod, "AsyncLocalStorage");
    if (typeof ctor !== "function") return null;
    const instance: unknown = Reflect.construct(ctor, []);
    return isAsyncLocalStorageLike(instance) ? instance : null;
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
