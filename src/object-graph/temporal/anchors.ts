import { Temporal } from "./index";

/**
 * `PlainTime` / `PlainYearMonth` / `PlainMonthDay` have no instant, and their
 * honest ISO forms ("18:30:00", "2026-06", "--06-01") are rejected by
 * InstantDB's `i.date()` (verified). To keep them in a queryable/orderable
 * `i.date()` column we anchor them to a real instant string — built purely with
 * Temporal (no JS `Date`). These are SENTINELS: code reading the column outside
 * the codec must not compare them against real timestamps.
 */

const TIME_ANCHOR_DATE = Temporal.PlainDate.from("1970-01-01");
const MONTH_DAY_ANCHOR_YEAR = 1972; // leap year, so --02-29 round-trips

/** `2026-06` → instant ISO at the first of the month, UTC midnight. */
export function yearMonthToAnchorIso(value: Temporal.PlainYearMonth): string {
  return value.toPlainDate({ day: 1 }).toZonedDateTime("UTC").toInstant().toString();
}

export function yearMonthFromAnchorIso(iso: string): Temporal.PlainYearMonth {
  return Temporal.Instant.from(iso).toZonedDateTimeISO("UTC").toPlainDate().toPlainYearMonth();
}

/** `18:30:00` → instant ISO on the 1970 anchor date, UTC. */
export function timeToAnchorIso(value: Temporal.PlainTime): string {
  return TIME_ANCHOR_DATE.toPlainDateTime(value).toZonedDateTime("UTC").toInstant().toString();
}

export function timeFromAnchorIso(iso: string): Temporal.PlainTime {
  return Temporal.Instant.from(iso).toZonedDateTimeISO("UTC").toPlainTime();
}

/** `--06-01` → instant ISO on the 1972 leap anchor year, UTC midnight. */
export function monthDayToAnchorIso(value: Temporal.PlainMonthDay): string {
  return value.toPlainDate({ year: MONTH_DAY_ANCHOR_YEAR }).toZonedDateTime("UTC").toInstant().toString();
}

export function monthDayFromAnchorIso(iso: string): Temporal.PlainMonthDay {
  return Temporal.Instant.from(iso).toZonedDateTimeISO("UTC").toPlainDate().toPlainMonthDay();
}
