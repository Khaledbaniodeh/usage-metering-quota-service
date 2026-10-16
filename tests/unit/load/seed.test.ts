import { describe, expect, it } from "vitest";
import {
  OLDEST_MONTH_KEY,
  ParameterError,
  parseProfileName,
  parseShape,
  PROFILES,
  REJECTED_UNITS,
  SEED_MONTHS,
  SEED_PLAN_LIMITS,
  totalDecisions,
  validateProfile,
} from "../../../load/lib/profiles.js";
import { DECISIONS_SQL, perMonth, seedStatements } from "../../../load/lib/seed-sql.js";

const secrets = { heavyKeyHash: Buffer.alloc(32, 1), noiseKeyHash: Buffer.alloc(32, 2) };

/** The decision statements' per-month counts: [heavy, background] for h and [noise] for n. */
function monthlyCounts(shape: "s2" | "s3", profile = PROFILES.full) {
  const statements = seedStatements(profile, shape, secrets).filter((s) => s.sql === DECISIONS_SQL);
  return {
    heavy: statements.filter((s) => s.params[2] === "h").map((s) => [s.params[4], s.params[7]]),
    noise: statements.filter((s) => s.params[2] === "n").map((s) => s.params[7]),
    append: statements.filter((s) => s.params[2] === "h").map((s) => s.params[8]),
  };
}

describe("profiles", () => {
  it("fixes twelve UTC months from 2025-01 to 2025-12; the oldest is measured", () => {
    expect(SEED_MONTHS).toEqual([
      "2025-01-01",
      "2025-02-01",
      "2025-03-01",
      "2025-04-01",
      "2025-05-01",
      "2025-06-01",
      "2025-07-01",
      "2025-08-01",
      "2025-09-01",
      "2025-10-01",
      "2025-11-01",
      "2025-12-01",
    ]);
    expect(OLDEST_MONTH_KEY).toBe("2025-01");
  });

  it("defines the approved S2 full dataset and a 1/100 smoke profile", () => {
    expect(totalDecisions(PROFILES.full)).toBe(1_200_000 + 99 * 2_000 + 100_000);
    expect(totalDecisions(PROFILES.smoke)).toBe(12_000 + 99 * 20 + 1_000);
    expect(PROFILES.smoke.backgroundUsers).toBe(PROFILES.full.backgroundUsers);
  });

  it("rejects one unit above the user plan's per-request limit", () => {
    expect(REJECTED_UNITS).toBe(SEED_PLAN_LIMITS.user.maxUnitsPerRequest + 1);
    expect(REJECTED_UNITS).toBeLessThanOrEqual(SEED_PLAN_LIMITS.account.maxUnitsPerRequest);
  });

  it.each([undefined, "", "FULL", "medium", "full;drop"])("rejects the profile name %j", (raw) => {
    expect(() => parseProfileName(raw)).toThrow(ParameterError);
  });

  it.each([undefined, "s1", "S2", " s2x"])("rejects the shape %j", (raw) => {
    expect(() => parseShape(raw)).toThrow(ParameterError);
  });

  it("accepts the documented names, trimmed", () => {
    expect(parseProfileName(" smoke ")).toBe("smoke");
    expect(parseShape("s3")).toBe("s3");
  });

  it.each([
    ["a fractional count", { heavyUserDecisions: 1.5 }],
    ["a negative count", { noiseDecisions: -12 }],
    ["fewer heavy decisions than months", { heavyUserDecisions: 11 }],
    ["no background users", { backgroundUsers: 0 }],
    ["rejectEvery below 2", { rejectEvery: 1 }],
    ["more than 5,000,000 decisions", { heavyUserDecisions: 6_000_000 }],
    ["NaN", { backgroundDecisionsPerUser: Number.NaN }],
  ])("rejects a profile with %s", (_label, change) => {
    expect(() => validateProfile({ ...PROFILES.full, ...change })).toThrow(ParameterError);
  });
});

describe("seed statements", () => {
  it("splits counts over the months exactly, earlier months taking the remainder", () => {
    expect(perMonth(1_200_000)).toEqual(Array.from({ length: 12 }, () => 100_000));
    expect(perMonth(14)).toEqual([2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(perMonth(14).reduce((a, b) => a + b)).toBe(14);
  });

  it("S2 spreads background rows over every month, interleaved", () => {
    const counts = monthlyCounts("s2");

    expect(counts.heavy).toEqual(Array.from({ length: 12 }, () => [100_000, 16_500]));
    expect(counts.append.every((append) => append === false)).toBe(true);
    expect(counts.noise.reduce((a, b) => Number(a) + Number(b), 0)).toBe(100_000);
  });

  it("S3 puts every background row in the oldest month, after the heavy user's rows", () => {
    const counts = monthlyCounts("s3");

    expect(counts.heavy[0]).toEqual([100_000, 198_000]);
    expect(counts.heavy.slice(1).every(([, background]) => background === 0)).toBe(true);
    expect(counts.append.every((append) => append === true)).toBe(true);
  });

  it("seeds every row of the profile, in order: setup, 24 tenant-months, counters", () => {
    const statements = seedStatements(PROFILES.smoke, "s2", secrets);
    const decisions = statements.filter((s) => s.sql === DECISIONS_SQL);
    const rows = decisions.reduce((sum, s) => sum + Number(s.params[4]) + Number(s.params[7]), 0);

    expect(rows).toBe(totalDecisions(PROFILES.smoke));
    expect(statements.map((s) => s.label)).toEqual([
      "accounts",
      "plans",
      "account plan h",
      "account plan n",
      "users",
      ...SEED_MONTHS.flatMap((month) => [`decisions h ${month}`, `decisions n ${month}`]),
      "account counters",
      "user counters",
    ]);
  });

  it("passes every variable value as a bound parameter, never inside the SQL text", () => {
    for (const statement of seedStatements(PROFILES.full, "s2", secrets)) {
      expect(statement.sql).not.toMatch(/1200000|1_200_000|16500|umqs_|\\x01/);
      expect(statement.params.length).toBe(new Set(statement.sql.match(/\$\d+/g) ?? []).size);
    }
  });

  it("refuses an invalid profile before producing any statement", () => {
    expect(() => seedStatements({ ...PROFILES.full, rejectEvery: 0 }, "s2", secrets)).toThrow(
      ParameterError,
    );
  });
});
