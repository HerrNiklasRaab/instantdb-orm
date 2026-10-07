import type { TransactionOutcome } from "../../transactions";

/** A store transaction's result together with the server's verdict on it. */
export interface Settled<T> {
  readonly result: T;
  /** `committed` or `denied`; a denial has already been taken back in the models. */
  readonly outcome: TransactionOutcome;
}

/**
 * What `store.transaction(fn)` returns: a promise of `fn`'s result, resolved
 * once the change is applied locally — online or offline alike — and
 * rejected only when `fn` throws. `settled()` waits for the server's verdict,
 * which is a value, never an exception; offline it waits until the device is
 * back online, unless `signal` stops it.
 */
export type TransactionHandle<T> = Promise<T> & {
  settled(options?: { signal?: AbortSignal }): Promise<Settled<T>>;
};
