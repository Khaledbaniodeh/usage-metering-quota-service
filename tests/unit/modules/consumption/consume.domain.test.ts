import { describe, expect, it } from "vitest";
import {
  evaluateQuota,
  isSamePayload,
  QUOTA_LEVELS,
  QUOTA_RULES,
  remainingAllowance,
  RULE_ORDER,
  toDecisionResponse,
  toMonthKey,
  utcMonthStart,
  type ConsumeDecision,
  type QuotaInput,
  type QuotaPosition,
} from "../../../../src/modules/consumption/consume.domain.js";

/** Starter account (10,000 / 100) and Basic user (1,000 / 20), both unused. */
function position(overrides: Partial<QuotaPosition>, base: QuotaPosition): QuotaPosition {
  return { ...base, ...overrides };
}
const ACCOUNT: QuotaPosition = { monthlyAllowance: 10_000, maxUnitsPerRequest: 100, usedBefore: 0 };
const USER: QuotaPosition = { monthlyAllowance: 1_000, maxUnitsPerRequest: 20, usedBefore: 0 };

function input(
  units: number,
  account: Partial<QuotaPosition> = {},
  user: Partial<QuotaPosition> = {},
): QuotaInput {
  return { units, account: position(account, ACCOUNT), user: position(user, USER) };
}

const rejected = (blockingRule: string, blockingLevel: string) => ({
  accepted: false,
  blockingRule,
  blockingLevel,
});

describe("evaluateQuota", () => {
  it("accepts a request that every rule allows", () => {
    expect(evaluateQuota(input(10))).toEqual({ accepted: true });
  });

  it("accepts the smallest request with a fresh allowance", () => {
    expect(evaluateQuota(input(1))).toEqual({ accepted: true });
  });

  describe("USER MAX_UNITS_PER_REQUEST", () => {
    it("accepts exactly the user's per-request limit", () => {
      expect(evaluateQuota(input(20))).toEqual({ accepted: true });
    });

    it("rejects one unit above it, even with both allowances unused (spec example: 25 units)", () => {
      expect(evaluateQuota(input(21))).toEqual(rejected("MAX_UNITS_PER_REQUEST", "USER"));
      expect(evaluateQuota(input(25))).toEqual(rejected("MAX_UNITS_PER_REQUEST", "USER"));
    });
  });

  describe("ACCOUNT MAX_UNITS_PER_REQUEST", () => {
    it("accepts exactly the account's per-request limit", () => {
      expect(evaluateQuota(input(100, {}, { maxUnitsPerRequest: 500 }))).toEqual({
        accepted: true,
      });
    });

    it("rejects one unit above it when the user's limit allows the request", () => {
      expect(evaluateQuota(input(101, {}, { maxUnitsPerRequest: 500 }))).toEqual(
        rejected("MAX_UNITS_PER_REQUEST", "ACCOUNT"),
      );
    });
  });

  describe("USER MONTHLY_ALLOWANCE", () => {
    it("accepts a request that uses exactly the rest of the user's allowance", () => {
      expect(evaluateQuota(input(10, {}, { usedBefore: 990 }))).toEqual({ accepted: true });
    });

    it("rejects the next unit beyond the user's allowance", () => {
      expect(evaluateQuota(input(1, {}, { usedBefore: 1_000 }))).toEqual(
        rejected("MONTHLY_ALLOWANCE", "USER"),
      );
      expect(evaluateQuota(input(11, {}, { usedBefore: 990 }))).toEqual(
        rejected("MONTHLY_ALLOWANCE", "USER"),
      );
    });

    it("rejects when the allowance was reduced below existing usage", () => {
      expect(evaluateQuota(input(1, {}, { usedBefore: 1_500 }))).toEqual(
        rejected("MONTHLY_ALLOWANCE", "USER"),
      );
    });
  });

  describe("ACCOUNT MONTHLY_ALLOWANCE", () => {
    it("accepts a request that uses exactly the rest of the account's allowance", () => {
      expect(evaluateQuota(input(10, { usedBefore: 9_990 }))).toEqual({ accepted: true });
    });

    it("rejects a 10-unit request when the account has only five units left (spec example)", () => {
      expect(evaluateQuota(input(10, { usedBefore: 9_995 }))).toEqual(
        rejected("MONTHLY_ALLOWANCE", "ACCOUNT"),
      );
    });

    it("rejects the next unit beyond the account's allowance", () => {
      expect(evaluateQuota(input(1, { usedBefore: 10_000 }))).toEqual(
        rejected("MONTHLY_ALLOWANCE", "ACCOUNT"),
      );
    });
  });

  describe("fixed priority when several rules fail", () => {
    it("reports USER per-request before every other rule", () => {
      expect(
        evaluateQuota(
          input(150, { usedBefore: 10_000 }, { usedBefore: 1_000, maxUnitsPerRequest: 20 }),
        ),
      ).toEqual(rejected("MAX_UNITS_PER_REQUEST", "USER"));
    });

    it("reports ACCOUNT per-request before both monthly allowances", () => {
      expect(
        evaluateQuota(
          input(150, { usedBefore: 10_000 }, { usedBefore: 1_000, maxUnitsPerRequest: 500 }),
        ),
      ).toEqual(rejected("MAX_UNITS_PER_REQUEST", "ACCOUNT"));
    });

    it("reports USER monthly before ACCOUNT monthly", () => {
      expect(evaluateQuota(input(10, { usedBefore: 10_000 }, { usedBefore: 1_000 }))).toEqual(
        rejected("MONTHLY_ALLOWANCE", "USER"),
      );
    });

    it("checks the rules in the documented order", () => {
      expect(RULE_ORDER.map(({ rule, level }) => `${level} ${rule}`)).toEqual([
        "USER MAX_UNITS_PER_REQUEST",
        "ACCOUNT MAX_UNITS_PER_REQUEST",
        "USER MONTHLY_ALLOWANCE",
        "ACCOUNT MONTHLY_ALLOWANCE",
      ]);
    });

    it("covers every rule at every level exactly once", () => {
      const pairs = RULE_ORDER.map(({ rule, level }) => `${level} ${rule}`);
      const expected = QUOTA_LEVELS.flatMap((level) =>
        QUOTA_RULES.map((rule) => `${level} ${rule}`),
      );
      expect([...pairs].sort()).toEqual([...expected].sort());
    });
  });

  it("works at the 1,000,000,000 limit without overflow", () => {
    const max = 1_000_000_000;
    const huge: QuotaPosition = { monthlyAllowance: max, maxUnitsPerRequest: max, usedBefore: 0 };
    expect(evaluateQuota({ units: max, account: huge, user: huge })).toEqual({ accepted: true });
    expect(
      evaluateQuota({ units: max, account: huge, user: { ...huge, usedBefore: max } }),
    ).toEqual(rejected("MONTHLY_ALLOWANCE", "USER"));
  });
});

describe("utcMonthStart", () => {
  it.each([
    ["2026-10-13T12:00:00.000Z", "2026-10-01"],
    ["2026-10-01T00:00:00.000Z", "2026-10-01"],
    ["2026-10-31T23:59:59.999Z", "2026-10-01"],
    ["2026-11-01T00:00:00.000Z", "2026-11-01"],
    ["2026-12-31T23:59:59.999Z", "2026-12-01"],
    ["2027-01-01T00:00:00.000Z", "2027-01-01"],
    ["2028-02-29T12:00:00.000Z", "2028-02-01"],
  ])("puts %s in the month starting %s", (instant, expected) => {
    expect(utcMonthStart(new Date(instant))).toBe(expected);
  });

  it("uses UTC, not the offset written in the input", () => {
    // 23:30 on 31 October in UTC-05:00 is already 1 November in UTC.
    expect(utcMonthStart(new Date("2026-10-31T23:30:00.000-05:00"))).toBe("2026-11-01");
    // 00:30 on 1 November in UTC+02:00 is still 31 October in UTC.
    expect(utcMonthStart(new Date("2026-11-01T00:30:00.000+02:00"))).toBe("2026-10-01");
  });

  it("pads four-digit years and two-digit months", () => {
    expect(utcMonthStart(new Date("0999-03-15T00:00:00.000Z"))).toBe("0999-03-01");
  });
});

describe("toMonthKey", () => {
  it("returns the YYYY-MM form of a stored month", () => {
    expect(toMonthKey("2026-10-01")).toBe("2026-10");
  });
});

describe("remainingAllowance", () => {
  it.each([
    [1_000, 0, 1_000],
    [1_000, 999, 1],
    [1_000, 1_000, 0],
    [1_000, 1_500, 0],
  ])("allowance %i with %i used leaves %i", (allowance, used, expected) => {
    expect(remainingAllowance(allowance, used)).toBe(expected);
  });
});

const DECISION: ConsumeDecision = {
  requestId: "req-1",
  userId: "11111111-1111-4111-8111-111111111111",
  units: 10,
  accepted: true,
  blockingRule: null,
  blockingLevel: null,
  month: "2026-10-01",
  processedAt: new Date("2026-10-13T12:00:00.123Z"),
  account: {
    planId: "a0000000-0000-4000-8000-000000000001",
    planName: "Starter",
    monthlyAllowance: 10_000,
    maxUnitsPerRequest: 100,
    usedBefore: 40,
  },
  user: {
    planId: "b0000000-0000-4000-8000-000000000001",
    planName: "Basic",
    monthlyAllowance: 1_000,
    maxUnitsPerRequest: 20,
    usedBefore: 995,
  },
};

describe("toDecisionResponse", () => {
  it("counts the units of an accepted decision in both levels' usage", () => {
    expect(toDecisionResponse({ ...DECISION, user: { ...DECISION.user, usedBefore: 30 } })).toEqual(
      {
        requestId: "req-1",
        userId: "11111111-1111-4111-8111-111111111111",
        units: 10,
        accepted: true,
        blockingRule: null,
        blockingLevel: null,
        month: "2026-10",
        processedAt: "2026-10-13T12:00:00.123Z",
        account: {
          planId: "a0000000-0000-4000-8000-000000000001",
          planName: "Starter",
          monthlyAllowance: 10_000,
          maxUnitsPerRequest: 100,
          used: 50,
          remaining: 9_950,
        },
        user: {
          planId: "b0000000-0000-4000-8000-000000000001",
          planName: "Basic",
          monthlyAllowance: 1_000,
          maxUnitsPerRequest: 20,
          used: 40,
          remaining: 960,
        },
      },
    );
  });

  it("counts nothing for a rejected decision and reports its blocking rule", () => {
    const response = toDecisionResponse({
      ...DECISION,
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "USER",
    });

    expect(response).toMatchObject({
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "USER",
      account: { used: 40, remaining: 9_960 },
      user: { used: 995, remaining: 5 },
    });
  });

  it("clamps remaining to zero when usage exceeds a reduced allowance", () => {
    const response = toDecisionResponse({
      ...DECISION,
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "USER",
      user: { ...DECISION.user, monthlyAllowance: 500, usedBefore: 995 },
    });

    expect(response.user).toMatchObject({ used: 995, remaining: 0 });
  });

  it("is deterministic: the same record always gives the same response", () => {
    expect(JSON.stringify(toDecisionResponse(DECISION))).toBe(
      JSON.stringify(toDecisionResponse(structuredClone(DECISION))),
    );
  });
});

describe("isSamePayload", () => {
  it("matches only the same user and units", () => {
    expect(isSamePayload(DECISION, { userId: DECISION.userId, units: 10 })).toBe(true);
    expect(isSamePayload(DECISION, { userId: DECISION.userId, units: 11 })).toBe(false);
    expect(
      isSamePayload(DECISION, { userId: "22222222-2222-4222-8222-222222222222", units: 10 }),
    ).toBe(false);
  });
});
