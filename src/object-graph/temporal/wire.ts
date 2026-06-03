import { temporalBrand } from "./codecs";
import { temporalCodecForValue } from "./registry";

/** True for any Temporal value (brand starts with "Temporal."). */
export function isTemporal(value: unknown): value is object {
  return value !== null && typeof value === "object" && temporalBrand(value) !== undefined;
}

/**
 * Equality for two Temporal values via their shared codec (Instant.equals,
 * Duration normalized-string, etc.). Returns false if they aren't both
 * Temporal of the same brand. The codec's `equals` is the single source.
 */
export function temporalEquals(a: unknown, b: unknown): boolean {
  if (!isTemporal(a) || !isTemporal(b)) return false;
  if (temporalBrand(a) !== temporalBrand(b)) return false;
  const codec = temporalCodecForValue(a);
  return codec ? codec.equalsUnknown(a, b) : false;
}
