import type { AnySchema } from "../../instantdb";
import type { ScopedTransaction } from "./ScopedTransaction";
import { syncGlobalState, type AsyncLocalStorageLike } from "../globalState";

function isRequire(value: unknown): value is (id: string) => unknown {
  return typeof value === "function";
}

function isAsyncLocalStorageLike(
  value: unknown
): value is AsyncLocalStorageLike<ScopedTransaction<AnySchema>> {
  if (value === null || typeof value !== "object") return false;
  const getStore: unknown = Reflect.get(value, "getStore");
  const run: unknown = Reflect.get(value, "run");
  return typeof getStore === "function" && typeof run === "function";
}

function loadAsyncHooksModule(): unknown {
  const proc: unknown = Reflect.get(globalThis, "process");
  if (proc !== null && typeof proc === "object") {
    const getBuiltinModule: unknown = Reflect.get(proc, "getBuiltinModule");
    if (typeof getBuiltinModule === "function") {
      try {
        return getBuiltinModule.call(proc, "node:async_hooks");
      } catch {
        // fall through to require
      }
    }
  }
  const requireRef: unknown = Reflect.get(globalThis, "require");
  if (!isRequire(requireRef)) return null;
  try {
    return requireRef("node:async_hooks");
  } catch {
    return null;
  }
}

function tryLoadAsyncHooks(): AsyncLocalStorageLike<ScopedTransaction<AnySchema>> | null {
  const mod = loadAsyncHooksModule();
  if (mod === null || typeof mod !== "object") return null;
  const ctor: unknown = Reflect.get(mod, "AsyncLocalStorage");
  if (typeof ctor !== "function") return null;
  const instance: unknown = Reflect.construct(ctor, []);
  return isAsyncLocalStorageLike(instance) ? instance : null;
}

function transactionAls(): AsyncLocalStorageLike<ScopedTransaction<AnySchema>> | null {
  const state = syncGlobalState();
  if (state.transactionAls === undefined) {
    state.transactionAls = tryLoadAsyncHooks();
  }
  return state.transactionAls;
}

export const TransactionContext = {
  get current(): ScopedTransaction<AnySchema> | null {
    const als = transactionAls();
    if (als) {
      return als.getStore() ?? null;
    }
    return syncGlobalState().transactionCurrent ?? null;
  },

  run<T>(tx: ScopedTransaction<AnySchema>, fn: () => T): T {
    const als = transactionAls();
    if (als) {
      return als.run(tx, fn);
    }
    const state = syncGlobalState();
    const previous = state.transactionCurrent ?? null;
    state.transactionCurrent = tx;
    try {
      return fn();
    } finally {
      state.transactionCurrent = previous;
    }
  },
};
