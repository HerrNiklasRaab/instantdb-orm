import { Temporal } from "./index";
import {
  ColumnCodec,
  type ColumnInfo,
  LeafCodec,
  type StorableValue,
} from "../columns/ColumnCodec";
import type { ColumnReader, ColumnType, ColumnValue, JsonValue, OutColumn } from "../columns/types";
import { camelJoin } from "../columns/types";
import {
  monthDayFromAnchorIso,
  monthDayToAnchorIso,
  timeFromAnchorIso,
  timeToAnchorIso,
  yearMonthFromAnchorIso,
  yearMonthToAnchorIso,
} from "./anchors";

/** Brand read off a value's spec-defined `Symbol.toStringTag`, if Temporal. */
export function temporalBrand(value: object): string | undefined {
  const tag: unknown = Reflect.get(value, Symbol.toStringTag);
  return typeof tag === "string" && tag.startsWith("Temporal.") ? tag : undefined;
}

/**
 * A Temporal type stored as its canonical ISO 8601 string in one column. No JS
 * `Date` anywhere — `serialize`/`parse` are the codec's own ISO form, and the
 * `date` columnType lets InstantDB index/order it. The full string round-trips
 * (InstantDB preserves it verbatim), so precision is whatever the value carries.
 */
abstract class TemporalLeafCodec<T extends StorableValue> extends LeafCodec<T> {
  abstract readonly brand: string;

  override accepts(value: unknown): value is T {
    return value !== null && typeof value === "object" && temporalBrand(value) === this.brand;
  }

  abstract parse(iso: string): T;
  protected abstract serialize(value: T): string;

  protected override encode(value: T): ColumnValue {
    return this.serialize(value);
  }

  protected override decode(raw: NonNullable<unknown>): T {
    if (typeof raw !== "string") throw new Error(`${this.brand}: expected ISO string, got ${typeof raw}.`);
    return this.parse(raw);
  }

  override toJson(value: T | null): JsonValue {
    return value === null ? null : this.serialize(value);
  }

  override fromJson(raw: unknown, _holderOptional: boolean): T | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") throw new Error(`${this.brand}: expected ISO string, got ${typeof raw}.`);
    return this.parse(raw);
  }
}

/** The six calendar/clock types stored in one `i.date()` column. */
abstract class DateLeafCodec<T extends StorableValue> extends TemporalLeafCodec<T> {
  readonly columnType: ColumnType = "date";
}

export class InstantCodec extends DateLeafCodec<Temporal.Instant> {
  readonly brand = "Temporal.Instant";
  parse(iso: string): Temporal.Instant { return Temporal.Instant.from(iso); }
  protected serialize(v: Temporal.Instant): string { return v.toString(); }
  equals(a: Temporal.Instant | null, b: Temporal.Instant | null): boolean {
    return a === null || b === null ? a === b : a.equals(b);
  }
}

export class PlainDateCodec extends DateLeafCodec<Temporal.PlainDate> {
  readonly brand = "Temporal.PlainDate";
  parse(iso: string): Temporal.PlainDate { return Temporal.PlainDate.from(iso); }
  protected serialize(v: Temporal.PlainDate): string { return v.toString(); }
  equals(a: Temporal.PlainDate | null, b: Temporal.PlainDate | null): boolean {
    return a === null || b === null ? a === b : a.equals(b);
  }
}

/**
 * Anchored date codec: the in-memory value (e.g. PlainTime "18:30") has no
 * instant and its honest ISO is rejected by `i.date()`, so the *column* stores
 * an anchored instant ISO (`encode`/`decode`), while JSON embedding keeps the
 * honest form (`serialize`/`toJson`). The anchor never leaks past the column.
 */
abstract class AnchoredDateCodec<T extends StorableValue> extends DateLeafCodec<T> {
  protected abstract toAnchorIso(value: T): string;
  protected abstract fromAnchorIso(iso: string): T;

  protected override encode(value: T): ColumnValue {
    return this.toAnchorIso(value);
  }
  protected override decode(raw: NonNullable<unknown>): T {
    if (typeof raw !== "string") throw new Error(`${this.brand}: expected anchored ISO string, got ${typeof raw}.`);
    return this.fromAnchorIso(raw);
  }
}

export class PlainTimeCodec extends AnchoredDateCodec<Temporal.PlainTime> {
  readonly brand = "Temporal.PlainTime";
  parse(iso: string): Temporal.PlainTime { return Temporal.PlainTime.from(iso); }
  protected serialize(v: Temporal.PlainTime): string { return v.toString(); }
  protected toAnchorIso(v: Temporal.PlainTime): string { return timeToAnchorIso(v); }
  protected fromAnchorIso(iso: string): Temporal.PlainTime { return timeFromAnchorIso(iso); }
  equals(a: Temporal.PlainTime | null, b: Temporal.PlainTime | null): boolean {
    return a === null || b === null ? a === b : a.equals(b);
  }
}

export class PlainDateTimeCodec extends DateLeafCodec<Temporal.PlainDateTime> {
  readonly brand = "Temporal.PlainDateTime";
  parse(iso: string): Temporal.PlainDateTime { return Temporal.PlainDateTime.from(iso); }
  protected serialize(v: Temporal.PlainDateTime): string { return v.toString(); }
  equals(a: Temporal.PlainDateTime | null, b: Temporal.PlainDateTime | null): boolean {
    return a === null || b === null ? a === b : a.equals(b);
  }
}

export class PlainYearMonthCodec extends AnchoredDateCodec<Temporal.PlainYearMonth> {
  readonly brand = "Temporal.PlainYearMonth";
  parse(iso: string): Temporal.PlainYearMonth { return Temporal.PlainYearMonth.from(iso); }
  protected serialize(v: Temporal.PlainYearMonth): string { return v.toString(); }
  protected toAnchorIso(v: Temporal.PlainYearMonth): string { return yearMonthToAnchorIso(v); }
  protected fromAnchorIso(iso: string): Temporal.PlainYearMonth { return yearMonthFromAnchorIso(iso); }
  equals(a: Temporal.PlainYearMonth | null, b: Temporal.PlainYearMonth | null): boolean {
    return a === null || b === null ? a === b : a.equals(b);
  }
}

export class PlainMonthDayCodec extends AnchoredDateCodec<Temporal.PlainMonthDay> {
  readonly brand = "Temporal.PlainMonthDay";
  parse(iso: string): Temporal.PlainMonthDay { return Temporal.PlainMonthDay.from(iso); }
  protected serialize(v: Temporal.PlainMonthDay): string { return v.toString(); }
  protected toAnchorIso(v: Temporal.PlainMonthDay): string { return monthDayToAnchorIso(v); }
  protected fromAnchorIso(iso: string): Temporal.PlainMonthDay { return monthDayFromAnchorIso(iso); }
  equals(a: Temporal.PlainMonthDay | null, b: Temporal.PlainMonthDay | null): boolean {
    return a === null || b === null ? a === b : a.equals(b);
  }
}

/** Duration: one `i.string()` column (ISO 8601). Equality = normalized string. */
export class DurationCodec extends TemporalLeafCodec<Temporal.Duration> {
  readonly brand = "Temporal.Duration";
  readonly columnType: ColumnType = "scalar";
  parse(iso: string): Temporal.Duration { return Temporal.Duration.from(iso); }
  protected serialize(v: Temporal.Duration): string { return v.toString(); }
  equals(a: Temporal.Duration | null, b: Temporal.Duration | null): boolean {
    if (a === null || b === null) return a === b;
    return a.toString() === b.toString();
  }
}

const ZDT_INSTANT = "instant";
const ZDT_ZONE = "zone";

/** ZonedDateTime: instant (`i.date()`) + IANA zone (`i.string()`). Offset is
 * recomputed from instant+zone on read, so DST/fall-back round-trip exactly. */
export class ZonedDateTimeCodec extends ColumnCodec<Temporal.ZonedDateTime> {
  readonly brand = "Temporal.ZonedDateTime";

  override accepts(value: unknown): value is Temporal.ZonedDateTime {
    return value !== null && typeof value === "object" && temporalBrand(value) === this.brand;
  }

  parse(iso: string): Temporal.ZonedDateTime { return Temporal.ZonedDateTime.from(iso); }

  override columns(prefix: string): readonly ColumnInfo[] {
    return [
      { name: camelJoin(prefix, ZDT_INSTANT), type: "date" },
      { name: camelJoin(prefix, ZDT_ZONE), type: "scalar" },
    ];
  }

  override decompose(
    prefix: string,
    value: Temporal.ZonedDateTime | null,
    holderOptional: boolean,
    out: OutColumn[]
  ): void {
    out.push({
      columnName: camelJoin(prefix, ZDT_INSTANT),
      value: value === null ? null : value.toInstant().toString(),
      optional: holderOptional,
    });
    out.push({
      columnName: camelJoin(prefix, ZDT_ZONE),
      value: value === null ? null : value.timeZoneId,
      optional: holderOptional,
    });
  }

  override assemble(prefix: string, _holderOptional: boolean, read: ColumnReader): Temporal.ZonedDateTime | null {
    const instantRaw: unknown = read(camelJoin(prefix, ZDT_INSTANT));
    const zoneRaw: unknown = read(camelJoin(prefix, ZDT_ZONE));
    if (instantRaw === null || instantRaw === undefined) return null;
    if (zoneRaw === null || zoneRaw === undefined) return null;
    if (typeof instantRaw !== "string") {
      throw new Error(`Temporal.ZonedDateTime: expected instant ISO string, got ${typeof instantRaw}.`);
    }
    if (typeof zoneRaw !== "string") {
      throw new Error(`Temporal.ZonedDateTime: expected zone id string, got ${typeof zoneRaw}.`);
    }
    return Temporal.Instant.from(instantRaw).toZonedDateTimeISO(zoneRaw);
  }

  override equals(a: Temporal.ZonedDateTime | null, b: Temporal.ZonedDateTime | null): boolean {
    if (a === null || b === null) return a === b;
    return a.equals(b);
  }

  override toJson(value: Temporal.ZonedDateTime | null): JsonValue {
    return value === null ? null : value.toString();
  }

  override fromJson(raw: unknown, _holderOptional: boolean): Temporal.ZonedDateTime | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") throw new Error(`Temporal.ZonedDateTime: expected ISO string, got ${typeof raw}.`);
    return Temporal.ZonedDateTime.from(raw);
  }
}
