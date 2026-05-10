/**
 * Re-entrancy guard for hydration writes. While >0, MobX intercepts driven
 * by the hydrator's own field assignments and array splices must NOT throw
 * (or claim into a transaction) — those mutations are framework bookkeeping,
 * not user intent.
 *
 * Without this guard, the tx-only enforcement in `ChangeTracker` would fire
 * on every hydration write and break query/subscribe paths.
 */
let hydrationDepth = 0;

export function isHydrationInProgress(): boolean {
  return hydrationDepth > 0;
}

export function withHydration<T>(fn: () => T): T {
  hydrationDepth++;
  try {
    return fn();
  } finally {
    hydrationDepth--;
  }
}
