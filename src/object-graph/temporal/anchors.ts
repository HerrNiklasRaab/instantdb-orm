import { Temporal } from "./index";

/**
 * The plain (zone-less) Temporal types have no instant, but a `timestamptz`
 * column stores nothing else, so each is anchored to an instant at UTC — built
 * purely with Temporal (no JS `Date`). Time-only and month-day values use
 * SENTINEL dates: code reading those columns outside the codec must not
 * compare them against real timestamps.
 */

const TIME_ANCHOR_DATE = Temporal.PlainDate.from("1970-01-01");
const MONTH_DAY_ANCHOR_YEAR = 1972; // leap year, so --02-29 round-trips

/** `2026-06-01` → instant ISO at UTC midnight. */
export function dateToAnchorIso(value: Temporal.PlainDate): string {
  return value.toZonedDateTime("UTC").toInstant().toString();
}

export function dateFromAnchorIso(iso: string): Temporal.PlainDate {
  return Temporal.Instant.from(iso).toZonedDateTimeISO("UTC").toPlainDate();
}

/** `2026-06-01T10:30` → instant ISO reading the wall clock as UTC. */
export function dateTimeToAnchorIso(value: Temporal.PlainDateTime): string {
  return value.toZonedDateTime("UTC").toInstant().toString();
}

export function dateTimeFromAnchorIso(iso: string): Temporal.PlainDateTime {
  return Temporal.Instant.from(iso).toZonedDateTimeISO("UTC").toPlainDateTime();
}

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
