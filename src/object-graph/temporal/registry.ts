import type { ColumnCodec, StorableValue } from "../columns/ColumnCodec";
import {
  DurationCodec,
  InstantCodec,
  PlainDateCodec,
  PlainDateTimeCodec,
  PlainMonthDayCodec,
  PlainTimeCodec,
  PlainYearMonthCodec,
  ZonedDateTimeCodec,
  temporalBrand,
} from "./codecs";

interface BrandedCodec {
  readonly brand: string;
}

const ALL: readonly (ColumnCodec<StorableValue> & BrandedCodec)[] = [
  new InstantCodec(),
  new ZonedDateTimeCodec(),
  new PlainDateCodec(),
  new PlainTimeCodec(),
  new PlainDateTimeCodec(),
  new PlainYearMonthCodec(),
  new PlainMonthDayCodec(),
  new DurationCodec(),
];

const BY_BRAND = new Map<string, ColumnCodec<StorableValue>>(ALL.map((c) => [c.brand, c]));

/** Resolve a codec from a constructor (`@field({ type: Temporal.X })`). */
export function temporalCodecForCtor(ctor: object): ColumnCodec<StorableValue> | undefined {
  if (typeof ctor !== "function") return undefined;
  const proto: unknown = Reflect.get(ctor, "prototype");
  if (proto === null || typeof proto !== "object") return undefined;
  const brand = temporalBrand(proto);
  return brand === undefined ? undefined : BY_BRAND.get(brand);
}

/** Resolve a codec from a live Temporal value (serialize / display dispatch). */
export function temporalCodecForValue(value: object): ColumnCodec<StorableValue> | undefined {
  const brand = temporalBrand(value);
  return brand === undefined ? undefined : BY_BRAND.get(brand);
}

const INSTANT_CODEC = new InstantCodec();

/** The default codec for an un-annotated `i.date()` column: Temporal.Instant. */
export function instantCodec(): ColumnCodec<StorableValue> {
  return INSTANT_CODEC;
}

export { temporalBrand };
