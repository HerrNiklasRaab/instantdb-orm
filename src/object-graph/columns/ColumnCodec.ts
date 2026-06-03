import type { ValueObject } from "../decorators/valueObject";
import type { Temporal } from "../temporal";
import type { ColumnReader, ColumnType, ColumnValue, JsonValue, OutColumn } from "./types";

export type TemporalValue =
  | Temporal.Instant
  | Temporal.ZonedDateTime
  | Temporal.PlainDate
  | Temporal.PlainTime
  | Temporal.PlainDateTime
  | Temporal.PlainYearMonth
  | Temporal.PlainMonthDay
  | Temporal.Duration;

/** Anything a stored property can hold; the widened element type for codecs. */
export type StorableValue = JsonValue | Date | ValueObject | TemporalValue;

/** One concrete column owned by a codec, with its InstantDB storage type. */
export interface ColumnInfo {
  readonly name: string;
  readonly type: ColumnType;
}

/**
 * Maps a typed value to/from InstantDB column(s). Knows nothing about the
 * property holding the value — that is `Field`'s job. This is the **storage**
 * concern; **cardinality** is the subclass split: `LeafCodec` for the
 * single-column case; multi-column codecs implement the surface directly. The
 * two together replace the old `ValueObjectStorage` 3-way enum: storage type
 * lives on each column (`ColumnInfo.type`), cardinality in the codec shape.
 *
 * Method syntax (not arrow fields) is deliberate: it lets a concrete
 * `ColumnCodec<Money>` be held as `ColumnCodec<StorableValue>` via TS
 * method-parameter bivariance, so `Field` carries heterogeneous codecs with no
 * assertion. `accepts` narrows the untyped read boundary (DB / `Reflect.get`)
 * without `as`, and doubles as fail-fast type validation.
 */
export abstract class ColumnCodec<T extends StorableValue> {
  /** Runtime type guard: is `value` a `T`? Narrows untyped reads + validates. */
  abstract accepts(value: unknown): value is T;

  /** Concrete columns (name + storage type) owned under `prefix`. */
  abstract columns(prefix: string): readonly ColumnInfo[];

  columnNames(prefix: string): string[] {
    return this.columns(prefix).map((c) => c.name);
  }

  /** Value → columns. `null` writes null to every owned column. */
  abstract decompose(prefix: string, value: T | null, holderOptional: boolean, out: OutColumn[]): void;

  /** Columns → value. */
  abstract assemble(prefix: string, holderOptional: boolean, read: ColumnReader): T | null;

  abstract equals(a: T | null, b: T | null): boolean;

  /** Value → JSON-embeddable form (when this codec nests inside a json column). */
  abstract toJson(value: T | null): JsonValue;

  /** JSON-embedded form → value. */
  abstract fromJson(raw: unknown, holderOptional: boolean): T | null;

  /** Equality for two untyped values. Narrows via `accepts`, no assertion. */
  equalsUnknown(a: unknown, b: unknown): boolean {
    const av = a === undefined ? null : a;
    const bv = b === undefined ? null : b;
    if (av !== null && !this.accepts(av)) return false;
    if (bv !== null && !this.accepts(bv)) return false;
    return this.equals(av, bv);
  }
}

/** A codec owning exactly one column of one `ColumnType`. */
export abstract class LeafCodec<T extends StorableValue> extends ColumnCodec<T> {
  abstract readonly columnType: ColumnType;

  override columns(prefix: string): readonly ColumnInfo[] {
    return [{ name: prefix, type: this.columnType }];
  }

  override decompose(prefix: string, value: T | null, holderOptional: boolean, out: OutColumn[]): void {
    out.push({
      columnName: prefix,
      value: value === null ? null : this.encode(value),
      optional: holderOptional,
    });
  }

  override assemble(prefix: string, _holderOptional: boolean, read: ColumnReader): T | null {
    const raw: unknown = read(prefix);
    if (raw === null || raw === undefined) return null;
    return this.decode(raw);
  }

  override toJson(value: T | null): JsonValue {
    if (value === null) return null;
    return this.encode(value);
  }

  override fromJson(raw: unknown, _holderOptional: boolean): T | null {
    if (raw === null || raw === undefined) return null;
    return this.decode(raw);
  }

  /** Value → its single column value. */
  protected abstract encode(value: T): ColumnValue;
  /** Raw (non-null) column value → value. Narrow `raw` with guards, no `as`. */
  protected abstract decode(raw: NonNullable<unknown>): T;
}
