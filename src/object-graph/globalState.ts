import type { AnySchema } from "../instantdb";
import type { EntityRegistry } from "./store/EntityMeta";
import type { ModelRegistry } from "./store/ModelRegistry";
import type { ScopedTransaction } from "./persistence/ScopedTransaction";
import type { ValueObjectClass } from "./decorators/valueObject";

export type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

export interface AsyncDepthSlot {
  storage: AsyncLocalStorageLike<number> | null;
  fallback: { count: number };
}

/**
 * Turbopack/Next compiles @upfor/sync into many module copies (one per server
 * compilation context — RSC, SSR, each route, each server action). Module-level
 * state diverges per copy, which breaks cross-bundle identity: two `Model`
 * classes, two registries, hydration throwing "non-Model instance".
 *
 * The clean fix would be externalizing the package so Node loads it once, but
 * that is blocked for symlinked workspace packages: `serverExternalPackages`
 * matches the *resolved* path against a `/node_modules/` regex, and a symlinked
 * workspace package resolves to `/packages/...`, so the externalize never fires
 * (https://github.com/vercel/next.js/issues/43433). Turbopack's native matcher
 * has the same bug and, unlike webpack, exposes no request-string `externals`
 * escape hatch. So under turbopack + symlinked workspaces there is no
 * single-copy option.
 *
 * Therefore we make duplication harmless instead of eliminating it — "singleton
 * proof" across copies via two mechanisms:
 *   - globalThis (this file): all mutable singletons live here, so every copy
 *     reads/writes the same instances. This interface is the single inventory
 *     of what must be shared.
 *   - Symbol.for(...) keys (see decorators): per-class metadata is stashed under
 *     globally-registered symbols, so a key minted in one copy resolves in
 *     another. Plain Symbol() would mint a distinct key per copy and lose the
 *     metadata across the bundle boundary.
 *
 * Class identity (`instanceof`) can't be globalThis'd, so the hydrator and
 * RootStore route identity questions through the shared registry instead.
 */
interface SyncGlobalState {
  entityRegistry?: EntityRegistry;
  modelRegistry?: ModelRegistry;
  transactionAls?: AsyncLocalStorageLike<ScopedTransaction<AnySchema>> | null;
  transactionCurrent?: ScopedTransaction<AnySchema> | null;
  asyncDepths?: Map<string, AsyncDepthSlot>;
  valueObjectRegistry?: Map<object, ValueObjectClass>;
}

declare global {
  var __upforSyncState: SyncGlobalState | undefined;
}

export function syncGlobalState(): SyncGlobalState {
  return (globalThis.__upforSyncState ??= {});
}
