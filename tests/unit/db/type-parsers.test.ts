import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseSafeInteger, typeParsers } from "../../../src/db/type-parsers.js";
import { describeDatabaseTarget } from "../../../src/db/pool.js";

const { builtins } = pg.types;

describe("parseSafeInteger", () => {
  it.each([
    ["0", 0],
    ["42", 42],
    ["-7", -7],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("converts BIGINT text %s to a number", (text, expected) => {
    expect(parseSafeInteger(text)).toBe(expected);
  });

  it("refuses values that would lose precision", () => {
    expect(() => parseSafeInteger("9007199254740992")).toThrow(RangeError);
    expect(() => parseSafeInteger("9223372036854775807")).toThrow(RangeError);
  });
});

describe("typeParsers", () => {
  it("parses BIGINT as a safe number", () => {
    const parse = typeParsers.getTypeParser(builtins.INT8) as (value: string) => unknown;

    expect(parse("123")).toBe(123);
  });

  it("keeps DATE values as calendar-date strings instead of local-time Date objects", () => {
    const parse = typeParsers.getTypeParser(builtins.DATE) as (value: string) => unknown;

    expect(parse("2026-10-01")).toBe("2026-10-01");
  });

  it("keeps the default parsers for every other type", () => {
    const parse = typeParsers.getTypeParser(builtins.INT4) as (value: string) => unknown;

    expect(parse("5")).toBe(5);
  });
});

describe("describeDatabaseTarget", () => {
  it("exposes only host, port and database name", () => {
    const target = describeDatabaseTarget("postgres://admin:TopSecret@db.internal:6543/metering");

    expect(target).toEqual({ host: "db.internal", port: "6543", database: "metering" });
    expect(JSON.stringify(target)).not.toContain("TopSecret");
    expect(JSON.stringify(target)).not.toContain("admin");
  });

  it("defaults the port to 5432", () => {
    expect(describeDatabaseTarget("postgresql://user@localhost/app").port).toBe("5432");
  });
});
