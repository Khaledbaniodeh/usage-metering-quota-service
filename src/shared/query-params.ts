import { Type } from "typebox";
import { AppError } from "./http-errors.js";
import { MONTH_KEY_PATTERN } from "./utc-month.js";

/**
 * Query-string parameters arrive as raw strings and request coercion is disabled globally, so
 * every numeric or structured value is validated as a string by its schema and converted here.
 * A repeated parameter arrives as an array and fails its string schema.
 */

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

/** 1 to 100 written plainly: no sign, decimal point, exponent, whitespace or leading zero. */
const LIMIT_PATTERN = "^(?:[1-9][0-9]?|100)$";
const LIMIT = new RegExp(LIMIT_PATTERN);

export const LimitQuerySchema = Type.String({
  pattern: LIMIT_PATTERN,
  description: `Page size: an integer from 1 to ${String(PAGE_LIMIT_MAX)} (default ${String(PAGE_LIMIT_DEFAULT)})`,
});

export const MonthQuerySchema = Type.String({
  pattern: MONTH_KEY_PATTERN,
  description: "UTC month as YYYY-MM; a future month is rejected",
});

/** A month later than the current UTC month cannot have usage or decisions yet. */
export function futureMonth(): AppError {
  return new AppError("VALIDATION_ERROR", "month must not be in the future");
}

/** Any string: the decoder reports every defect as the same 400 "Invalid cursor". */
export const CursorQuerySchema = Type.String({
  description:
    "Opaque continuation value from a previous response's nextCursor. A continuation request may send only cursor (and optionally limit).",
});

/** Whether a raw query value is a valid page size. */
export function isPageLimit(raw: string): boolean {
  return LIMIT.test(raw);
}

/** The page size of a request: the default when absent, otherwise the validated value. */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return PAGE_LIMIT_DEFAULT;
  }
  if (!isPageLimit(raw)) {
    // Unreachable behind the route schema; guards direct callers.
    throw new Error("limit must be an integer from 1 to 100");
  }
  return Number(raw);
}
