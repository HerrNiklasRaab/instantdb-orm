/**
 * Stack-scoped boolean ("am I currently inside this kind of operation?")
 * backed by `AsyncLocalStorage` on Node so the value follows the async
 * context, with a sync-only module-level fallback on browser / React Native
 * where `node:async_hooks` doesn't exist.
 *
 * Used to express "the wirer is running," "we're inside a constructor
 * sweep," "the hydrator is writing" — all the same shape:
 *
 *   const wiring = makeAsyncDepth();
 *   wiring.wrap(() => doWiring());
 *   if (wiring.isActive()) { ... }
 *
 * Each caller owns its own depth instance, so concerns stay isolated.
 */

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

type AsyncLocalStorageCtorType = new <T>() => AsyncLocalStorageLike<T>;

function isRequire(value: unknown): value is (id: string) => unknown {
  return typeof value === "function";
}

function isAsyncLocalStorageCtor(value: unknown): value is AsyncLocalStorageCtorType {
  return typeof value === "function";
}

function loadAsyncLocalStorageCtor(): AsyncLocalStorageCtorType | null {
  const requireRef: unknown = Reflect.get(globalThis, "require");
  if (!isRequire(requireRef)) return null;
  try {
    const mod: unknown = requireRef("node:async_hooks");
    if (mod === null || typeof mod !== "object") return null;
    const ctor: unknown = Reflect.get(mod, "AsyncLocalStorage");
    return isAsyncLocalStorageCtor(ctor) ? ctor : null;
  } catch {
    return null;
  }
}

const AsyncLocalStorageCtor: AsyncLocalStorageCtorType | null = loadAsyncLocalStorageCtor();

export interface AsyncDepth {
  isActive(): boolean;
  wrap<T>(fn: () => T): T;
}

export function makeAsyncDepth(): AsyncDepth {
  const storage: AsyncLocalStorageLike<number> | null = AsyncLocalStorageCtor
    ? new AsyncLocalStorageCtor<number>()
    : null;
  let fallback = 0;

  return {
    isActive(): boolean {
      if (storage) return (storage.getStore() ?? 0) > 0;
      return fallback > 0;
    },
    wrap<T>(fn: () => T): T {
      if (storage) {
        const next = (storage.getStore() ?? 0) + 1;
        return storage.run(next, fn);
      }
      fallback++;
      try {
        return fn();
      } finally {
        fallback--;
      }
    },
  };
}
