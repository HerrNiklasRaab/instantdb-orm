export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A value as written to a single InstantDB column. Always a JSON primitive —
 * Temporal values are serialized to ISO strings by their codec before reaching
 * a column, so no JS `Date` ever appears here.
 */
export type ColumnValue = JsonValue;

/** The InstantDB attribute type backing a single column. */
export type ColumnType = "scalar" | "date" | "json";

/**
 * Reads a stored column value. Typed `unknown` because DB data is untyped at
 * this boundary; codecs narrow it with runtime guards.
 */
export type ColumnReader = (column: string) => unknown;

export interface OutColumn {
  readonly columnName: string;
  readonly value: ColumnValue;
  readonly optional: boolean;
}

export interface ColumnSpec {
  readonly suffix: string;
  readonly type: ColumnType;
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function camelJoin(prefix: string, suffix: string): string {
  if (suffix.length === 0) return prefix;
  if (prefix.length === 0) return suffix;
  return prefix + capitalize(suffix);
}
