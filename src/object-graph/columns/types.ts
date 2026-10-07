export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A value as stored in one column: always JSON. Model fields are encoded by
 * their codecs (a Temporal value becomes an ISO string) before they reach a
 * column, so no `Date` or class instance ever appears here.
 */
export type ColumnValue = JsonValue;

/** How a column is stored: a plain value, a date (an ISO string on the wire), or JSON. */
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
