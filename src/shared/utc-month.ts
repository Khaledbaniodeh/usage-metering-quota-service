/**
 * UTC calendar months. A month is exchanged as a `YYYY-MM` key in the API and stored as its first
 * day (`YYYY-MM-01`) in the database. Local time never takes part.
 */

/** A public month key: a four-digit year from 1000 and a two-digit month. */
export const MONTH_KEY_PATTERN = "^[1-9][0-9]{3}-(0[1-9]|1[0-2])$";

const MONTH_KEY = new RegExp(MONTH_KEY_PATTERN);

/** The first day of the UTC calendar month containing `instant`, as a `YYYY-MM-DD` date. */
export function utcMonthStart(instant: Date): string {
  const year = String(instant.getUTCFullYear()).padStart(4, "0");
  const month = String(instant.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** The public `YYYY-MM` form of a stored month (`YYYY-MM-01`). */
export function toMonthKey(monthStart: string): string {
  return monthStart.slice(0, 7);
}

/** The `YYYY-MM` key of the UTC month containing `instant`. */
export function utcMonthKey(instant: Date): string {
  return toMonthKey(utcMonthStart(instant));
}

/** The stored first day (`YYYY-MM-01`) of a `YYYY-MM` key. */
export function monthStartOf(monthKey: string): string {
  return `${monthKey}-01`;
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY.test(value);
}

/** Whether `monthKey` is later than the UTC month of `now` (fixed-width keys sort as text). */
export function isFutureMonth(monthKey: string, now: Date): boolean {
  return monthKey > utcMonthKey(now);
}
