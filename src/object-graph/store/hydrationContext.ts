import { makeAsyncDepth } from "./asyncDepth";

/**
 * Re-entrancy guard for hydration writes. While active, MobX intercepts
 * driven by the hydrator's own field assignments and array splices must NOT
 * throw (or claim into a transaction) — those mutations are framework
 * bookkeeping, not user intent.
 *
 * Without this guard, the tx-only enforcement on Model would fire on every
 * hydration write and break query/subscribe paths.
 */
const hydration = makeAsyncDepth();

export function isHydrationInProgress(): boolean {
  return hydration.isActive();
}

export function withHydration<T>(fn: () => T): T {
  return hydration.wrap(fn);
}
