import { describe, expect, it } from "vitest";
import {
  CURSOR_KINDS,
  CURSOR_MAX_LENGTH,
  decodeCursor,
  encodeCursor,
  type Cursor,
  type CursorKind,
} from "../../../src/shared/cursor.js";
import { AppError } from "../../../src/shared/http-errors.js";

const ANCHOR = "0b6f7a4e-2c1d-4e8f-9a3b-5c6d7e8f9a0b";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function sample(kind: CursorKind): Cursor {
  switch (kind) {
    case "users":
      return { kind, anchor: ANCHOR };
    case "usage-users":
      return { kind, anchor: ANCHOR, month: "2026-10", currentMonth: true };
    case "history":
      return { kind, anchor: ANCHOR, userId: USER, month: "2026-09" };
  }
}

/** U+FEFF, built from its code point so the source holds no invisible character. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const encodeJson = (json: string) => Buffer.from(json, "utf8").toString("base64url");
const encodeBytes = (bytes: readonly number[]) => Buffer.from(bytes).toString("base64url");

function rejection(kind: CursorKind, raw: string): unknown {
  try {
    decodeCursor(kind, raw);
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(kind: CursorKind, raw: string): void {
  const error = rejection(kind, raw);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    code: "VALIDATION_ERROR",
    statusCode: 400,
    message: "Invalid cursor",
  });
}

describe("encodeCursor / decodeCursor", () => {
  it.each(CURSOR_KINDS)("round-trips a %s cursor", (kind) => {
    const raw = encodeCursor(sample(kind));

    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(kind, raw)).toEqual(sample(kind));
  });

  it("encodes canonical JSON with a fixed key order and no table-wide sequence", () => {
    expect(Buffer.from(encodeCursor(sample("history")), "base64url").toString("utf8")).toBe(
      `{"v":1,"k":"history","a":"${ANCHOR}","u":"${USER}","m":"2026-09"}`,
    );
    expect(Buffer.from(encodeCursor(sample("usage-users")), "base64url").toString("utf8")).toBe(
      `{"v":1,"k":"usage-users","a":"${ANCHOR}","m":"2026-10","c":true}`,
    );
    expect(Buffer.from(encodeCursor(sample("users")), "base64url").toString("utf8")).toBe(
      `{"v":1,"k":"users","a":"${ANCHOR}"}`,
    );
  });

  it("accepts null history filters", () => {
    const cursor: Cursor = { kind: "history", anchor: ANCHOR, userId: null, month: null };

    expect(decodeCursor("history", encodeCursor(cursor))).toEqual(cursor);
  });

  it.each(
    CURSOR_KINDS.flatMap((kind) =>
      CURSOR_KINDS.filter((other) => other !== kind).map((other) => [kind, other] as const),
    ),
  )("rejects a %s cursor on the %s endpoint", (kind, other) => {
    expectInvalid(other, encodeCursor(sample(kind)));
  });
});

describe("strict decoding", () => {
  const valid = encodeCursor(sample("users"));

  it.each([
    ["an empty string", ""],
    ["padding", `${valid}==`],
    ["a standard base64 character (+)", `${valid.slice(0, -1)}+`],
    ["a standard base64 character (/)", `${valid.slice(0, -1)}/`],
    ["a dot", `${valid}.`],
    ["whitespace", ` ${valid}`],
    ["more than the maximum length", "A".repeat(CURSOR_MAX_LENGTH + 1)],
    ["random text", "not-a-cursor"],
  ])("rejects %s", (_label, raw) => {
    expectInvalid("users", raw);
  });

  it("rejects a non-canonical base64url spelling of valid bytes", () => {
    // Change only unused trailing bits: same bytes, different text.
    const bytes = Buffer.from(valid, "base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const variants = Array.from({ length: alphabet.length }, (_, index) => alphabet.charAt(index))
      .map((last) => `${valid.slice(0, -1)}${last}`)
      .filter((raw) => raw !== valid && Buffer.from(raw, "base64url").equals(bytes));
    expect(variants.length).toBeGreaterThan(0);

    for (const raw of variants) {
      expectInvalid("users", raw);
    }
  });

  it("rejects invalid UTF-8", () => {
    expectInvalid("users", encodeBytes([0x7b, 0xff, 0xfe, 0x7d]));
  });

  it("rejects a byte-order mark", () => {
    expectInvalid("users", encodeJson(`${BYTE_ORDER_MARK}{"v":1,"k":"users","a":"${ANCHOR}"}`));
  });

  it.each([
    ["invalid JSON", "{"],
    ["an array", `[1,"users","${ANCHOR}"]`],
    ["a string", `"${ANCHOR}"`],
    ["a number", "1"],
    ["null", "null"],
    ["a missing key", `{"v":1,"k":"users"}`],
    ["an extra key", `{"v":1,"k":"users","a":"${ANCHOR}","s":42}`],
    ["a duplicate key", `{"v":1,"k":"users","a":"${ANCHOR}","a":"${ANCHOR}"}`],
    ["another key order", `{"k":"users","v":1,"a":"${ANCHOR}"}`],
    ["whitespace", `{"v": 1,"k":"users","a":"${ANCHOR}"}`],
    ["version 2", `{"v":2,"k":"users","a":"${ANCHOR}"}`],
    ["a string version", `{"v":"1","k":"users","a":"${ANCHOR}"}`],
    ["a fractional version spelling", `{"v":1.0,"k":"users","a":"${ANCHOR}"}`],
    ["an unknown kind", `{"v":1,"k":"accounts","a":"${ANCHOR}"}`],
    ["an upper-case anchor", `{"v":1,"k":"users","a":"${ANCHOR.toUpperCase()}"}`],
    ["a non-UUID anchor", `{"v":1,"k":"users","a":"42"}`],
    ["a numeric anchor", `{"v":1,"k":"users","a":42}`],
    ["a null anchor", `{"v":1,"k":"users","a":null}`],
  ])("rejects a users cursor with %s", (_label, json) => {
    expectInvalid("users", encodeJson(json));
  });

  it.each([
    ["an invalid month", `{"v":1,"k":"usage-users","a":"${ANCHOR}","m":"2026-13","c":true}`],
    [
      "a date instead of a month",
      `{"v":1,"k":"usage-users","a":"${ANCHOR}","m":"2026-10-01","c":true}`,
    ],
    ["a null month", `{"v":1,"k":"usage-users","a":"${ANCHOR}","m":null,"c":true}`],
    ["a non-boolean flag", `{"v":1,"k":"usage-users","a":"${ANCHOR}","m":"2026-10","c":1}`],
    ["a missing flag", `{"v":1,"k":"usage-users","a":"${ANCHOR}","m":"2026-10"}`],
  ])("rejects a usage-users cursor with %s", (_label, json) => {
    expectInvalid("usage-users", encodeJson(json));
  });

  it.each([
    ["a non-UUID user", `{"v":1,"k":"history","a":"${ANCHOR}","u":"bob","m":null}`],
    [
      "an upper-case user",
      `{"v":1,"k":"history","a":"${ANCHOR}","u":"${USER.toUpperCase()}","m":null}`,
    ],
    ["an invalid month", `{"v":1,"k":"history","a":"${ANCHOR}","u":null,"m":"26-10"}`],
    ["an omitted filter", `{"v":1,"k":"history","a":"${ANCHOR}","u":null}`],
    ["a numeric month", `{"v":1,"k":"history","a":"${ANCHOR}","u":null,"m":202610}`],
  ])("rejects a history cursor with %s", (_label, json) => {
    expectInvalid("history", encodeJson(json));
  });
});
