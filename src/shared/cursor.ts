import { AppError } from "./http-errors.js";
import { isMonthKey } from "./utc-month.js";

/**
 * Opaque pagination cursors: unpadded base64url of canonical JSON. A cursor is a POSITION, not a
 * credential. It is neither encrypted nor signed, so a caller can decode it and can construct a
 * well-formed cursor pointing at one of its own rows; that is harmless because every anchor lookup
 * and page query is scoped to the authenticated account in SQL. Cursors carry no API keys, hashes,
 * SQL or table-wide sequence values: the anchor is the UUID of the last returned row.
 *
 * Decoding is strict, and every defect is reported identically (`invalidCursor()`).
 */

export const CURSOR_VERSION = 1;
export const CURSOR_MAX_LENGTH = 1024;

export const CURSOR_KINDS = ["users", "usage-users", "history"] as const;
export type CursorKind = (typeof CURSOR_KINDS)[number];

/** GET /v1/users: oldest first. */
export interface UsersCursor {
  readonly kind: "users";
  readonly anchor: string;
}

/** GET /v1/usage/users: the month and the representation are fixed for the whole traversal. */
export interface UsageUsersCursor {
  readonly kind: "usage-users";
  readonly anchor: string;
  readonly month: string;
  /** Whether the traversal began on the then-current month (live plan representation). */
  readonly currentMonth: boolean;
}

/** GET /v1/history: the effective filters are bound to the traversal. */
export interface HistoryCursor {
  readonly kind: "history";
  readonly anchor: string;
  readonly userId: string | null;
  readonly month: string | null;
}

export type Cursor = UsersCursor | UsageUsersCursor | HistoryCursor;

type CursorOf<Kind extends CursorKind> = Extract<Cursor, { readonly kind: Kind }>;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LOWER_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The single response for every unusable cursor, so no failure reveals why. */
export function invalidCursor(): AppError {
  return new AppError("VALIDATION_ERROR", "Invalid cursor");
}

/** The canonical JSON of a cursor: fixed key order, no whitespace. */
function canonicalJson(cursor: Cursor): string {
  switch (cursor.kind) {
    case "users":
      return JSON.stringify({ v: CURSOR_VERSION, k: cursor.kind, a: cursor.anchor });
    case "usage-users":
      return JSON.stringify({
        v: CURSOR_VERSION,
        k: cursor.kind,
        a: cursor.anchor,
        m: cursor.month,
        c: cursor.currentMonth,
      });
    case "history":
      return JSON.stringify({
        v: CURSOR_VERSION,
        k: cursor.kind,
        a: cursor.anchor,
        u: cursor.userId,
        m: cursor.month,
      });
  }
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isLowerCaseUuid(value: unknown): value is string {
  return typeof value === "string" && LOWER_CASE_UUID.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The decoded JSON value of a well-formed, canonical base64url string; undefined otherwise. */
function decodeJson(raw: string): unknown {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH || !BASE64URL.test(raw)) {
    return undefined;
  }
  const bytes = Buffer.from(raw, "base64url");
  // Rejects non-canonical encodings (e.g. different unused trailing bits).
  if (bytes.toString("base64url") !== raw) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toCursor(kind: CursorKind, value: Record<string, unknown>): Cursor | undefined {
  if (value.v !== CURSOR_VERSION || value.k !== kind || !isLowerCaseUuid(value.a)) {
    return undefined;
  }
  switch (kind) {
    case "users":
      return hasExactKeys(value, ["v", "k", "a"]) ? { kind, anchor: value.a } : undefined;
    case "usage-users":
      return hasExactKeys(value, ["v", "k", "a", "m", "c"]) &&
        isMonthKey(value.m) &&
        typeof value.c === "boolean"
        ? { kind, anchor: value.a, month: value.m, currentMonth: value.c }
        : undefined;
    case "history":
      return hasExactKeys(value, ["v", "k", "a", "u", "m"]) &&
        (value.u === null || isLowerCaseUuid(value.u)) &&
        (value.m === null || isMonthKey(value.m))
        ? { kind, anchor: value.a, userId: value.u, month: value.m }
        : undefined;
  }
}

/**
 * Decodes a cursor of the given kind or throws `invalidCursor()`. Accepts only the exact bytes
 * `encodeCursor` produces: canonical base64url, valid UTF-8, a plain object with exactly the
 * kind's keys and value types, version 1, this endpoint's kind and a lower-case UUID anchor.
 */
export function decodeCursor<Kind extends CursorKind>(kind: Kind, raw: string): CursorOf<Kind> {
  const value = decodeJson(raw);
  const cursor = isPlainObject(value) ? toCursor(kind, value) : undefined;
  // Canonical round trip: rejects whitespace, other key orders, duplicate keys and number forms.
  if (cursor === undefined || encodeCursor(cursor) !== raw) {
    throw invalidCursor();
  }
  return cursor as CursorOf<Kind>;
}
