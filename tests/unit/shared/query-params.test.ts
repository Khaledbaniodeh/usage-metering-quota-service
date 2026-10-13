import { describe, expect, it } from "vitest";
import {
  isPageLimit,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  parseLimit,
} from "../../../src/shared/query-params.js";
import {
  isFutureMonth,
  isMonthKey,
  monthStartOf,
  utcMonthKey,
} from "../../../src/shared/utc-month.js";

describe("limit", () => {
  it("defaults to 20 and allows up to 100", () => {
    expect(PAGE_LIMIT_DEFAULT).toBe(20);
    expect(PAGE_LIMIT_MAX).toBe(100);
    expect(parseLimit(undefined)).toBe(20);
  });

  it.each(["1", "9", "10", "20", "99", "100"])("accepts %s", (raw) => {
    expect(isPageLimit(raw)).toBe(true);
    expect(parseLimit(raw)).toBe(Number(raw));
  });

  it.each([
    "0",
    "101",
    "1000",
    "-1",
    "+5",
    "1.0",
    "1.5",
    "1e2",
    "1E1",
    "0x10",
    "01",
    "007",
    " 5",
    "5 ",
    "5\n",
    "",
    "five",
    "Infinity",
    "NaN",
  ])("rejects %j", (raw) => {
    expect(isPageLimit(raw)).toBe(false);
    expect(() => parseLimit(raw)).toThrow();
  });
});

describe("month keys", () => {
  it.each(["2026-10", "1000-01", "9999-12", "2027-01"])("accepts %s", (raw) => {
    expect(isMonthKey(raw)).toBe(true);
  });

  it.each([
    "2026-1",
    "2026-00",
    "2026-13",
    "0999-01",
    "0000-01",
    "2026-10-01",
    "26-10",
    "2026/10",
    " 2026-10",
    "2026-10 ",
    "",
  ])("rejects %j", (raw) => {
    expect(isMonthKey(raw)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isMonthKey(202610)).toBe(false);
    expect(isMonthKey(null)).toBe(false);
  });

  it("derives the UTC month key and its stored first day", () => {
    expect(utcMonthKey(new Date("2026-10-31T23:59:59.999Z"))).toBe("2026-10");
    expect(utcMonthKey(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
    expect(utcMonthKey(new Date("2026-10-31T23:30:00.000-05:00"))).toBe("2026-11");
    expect(monthStartOf("2026-10")).toBe("2026-10-01");
  });

  it("detects future months against the UTC month of now", () => {
    const now = new Date("2026-10-31T23:59:59.999Z");

    expect(isFutureMonth("2026-10", now)).toBe(false);
    expect(isFutureMonth("2026-09", now)).toBe(false);
    expect(isFutureMonth("2025-12", now)).toBe(false);
    expect(isFutureMonth("2026-11", now)).toBe(true);
    expect(isFutureMonth("2027-01", now)).toBe(true);
  });
});
