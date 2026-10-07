import { Temporal } from "@js-temporal/polyfill";

/**
 * The finest the storage round-trips: ZenStack hands `DateTime` back as a JS
 * `Date`. An instant is cut to it on the way in, so the value a model holds
 * is the value that comes back.
 */
const STORAGE_PRECISION = "millisecond";

export function atStoragePrecision(instant: Temporal.Instant): Temporal.Instant {
  return instant.round({ smallestUnit: STORAGE_PRECISION, roundingMode: "trunc" });
}

/** The current instant, at the precision the storage keeps. */
export function now(): Temporal.Instant {
  return atStoragePrecision(Temporal.Now.instant());
}
