import { describe, expect, it } from "vitest";
import type { Decision, Plan, User, UserUsage } from "../../../client/api-types.js";
import {
  CheckFailed,
  checkDecision,
  checkListedUsage,
  checkMonthlyUsage,
  describeDecision,
  FormMismatch,
  limitsOf,
  usageForm,
  type DecisionExpectation,
} from "../../../client/checks.js";

const BASIC: Plan = {
  id: "b0000000-0000-4000-8000-000000000001",
  code: "basic",
  name: "Basic",
  scope: "USER",
  monthlyAllowance: 1_000,
  maxUnitsPerRequest: 20,
};
const USER: User = {
  id: "22222222-2222-4222-8222-000000000001",
  name: "Example user 1",
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  plan: BASIC,
};
const CURRENT = { month: "2026-10", used: 5, plan: BASIC, form: "current" } as const;
const PAST = { ...CURRENT, form: "past" } as const;

describe("usageForm", () => {
  it("is current with all three live fields and past with none", () => {
    expect(usageForm({ monthlyAllowance: 1, maxUnitsPerRequest: 1, remaining: 0 }, "x")).toBe(
      "current",
    );
    expect(usageForm({}, "x")).toBe("past");
  });

  it.each([
    [{ monthlyAllowance: 1 }, 1],
    [{ monthlyAllowance: 1, remaining: 0 }, 2],
    [{ maxUnitsPerRequest: 1, remaining: 0 }, 2],
  ])("rejects a partial shape %o", (value, present) => {
    expect(() => usageForm(value, "account usage")).toThrow(
      new CheckFailed(
        `account usage: monthlyAllowance, maxUnitsPerRequest and remaining must be all present or all absent (${String(present)} of 3 present)`,
      ),
    );
  });
});

describe("checkMonthlyUsage", () => {
  const current = {
    month: "2026-10",
    used: 5,
    monthlyAllowance: 1_000,
    maxUnitsPerRequest: 20,
    remaining: 995,
  };

  it("accepts a correct current-month and past-month response", () => {
    expect(() => {
      checkMonthlyUsage(current, CURRENT, "usage");
    }).not.toThrow();
    expect(() => {
      checkMonthlyUsage({ month: "2026-10", used: 5 }, PAST, "usage");
    }).not.toThrow();
  });

  it("rejects a partial current-month response", () => {
    const partial = {
      month: current.month,
      used: current.used,
      monthlyAllowance: current.monthlyAllowance,
      maxUnitsPerRequest: current.maxUnitsPerRequest,
    };

    expect(() => {
      checkMonthlyUsage(partial, CURRENT, "usage");
    }).toThrow("(2 of 3 present)");
  });

  it("rejects the past form where the current form is expected, and the reverse", () => {
    expect(() => {
      checkMonthlyUsage({ month: "2026-10", used: 5 }, CURRENT, "usage");
    }).toThrow(new FormMismatch("usage: expected the current-month form, got the past-month form"));
    expect(() => {
      checkMonthlyUsage(current, PAST, "usage");
    }).toThrow(new FormMismatch("usage: expected the past-month form, got the current-month form"));
  });

  it.each([
    ["monthlyAllowance", { monthlyAllowance: 999 }],
    ["maxUnitsPerRequest", { maxUnitsPerRequest: 100 }],
    ["remaining", { remaining: 1_000 }],
  ])("rejects a wrong %s", (_field, change) => {
    expect(() => {
      checkMonthlyUsage({ ...current, ...change }, CURRENT, "usage");
    }).toThrow("usage [monthlyAllowance, maxUnitsPerRequest, remaining]: expected [1000,20,995]");
  });

  it("rejects the wrong month or used value", () => {
    expect(() => {
      checkMonthlyUsage({ ...current, month: "2026-09" }, CURRENT, "usage");
    }).toThrow('usage [month, used]: expected ["2026-10",5], got ["2026-09",5]');
    expect(() => {
      checkMonthlyUsage({ ...current, used: 17 }, CURRENT, "usage");
    }).toThrow('usage [month, used]: expected ["2026-10",5], got ["2026-10",17]');
  });
});

describe("checkListedUsage", () => {
  const listed: UserUsage = {
    userId: USER.id,
    name: USER.name,
    planId: BASIC.id,
    planName: BASIC.name,
    used: 5,
    monthlyAllowance: 1_000,
    maxUnitsPerRequest: 20,
    remaining: 995,
  };
  const expectCurrent = { user: USER, used: 5, form: "current" } as const;
  const expectPast = { user: USER, used: 5, form: "past" } as const;
  const pastItem: UserUsage = { userId: USER.id, name: USER.name, used: 5 };

  it("accepts a correct current-month and past-month item", () => {
    expect(() => {
      checkListedUsage(listed, expectCurrent, "item");
    }).not.toThrow();
    expect(() => {
      checkListedUsage(pastItem, expectPast, "item");
    }).not.toThrow();
  });

  it.each(["planId", "planName"] as const)("rejects a current-month item without %s", (field) => {
    // An absent field and an undefined one are the same to the check.
    const item = { ...listed, [field]: undefined };

    expect(() => {
      checkListedUsage(item, expectCurrent, "item");
    }).toThrow("item: planId and planName must be present exactly when the live limits are");
  });

  it("rejects a current-month item missing a live limit", () => {
    const item = { ...listed, maxUnitsPerRequest: undefined } as unknown as UserUsage;

    expect(() => {
      checkListedUsage(item, expectCurrent, "item");
    }).toThrow("(2 of 3 present)");
  });

  it("rejects a past-month item that still carries plan fields", () => {
    expect(() => {
      checkListedUsage({ ...pastItem, planId: BASIC.id }, expectPast, "item");
    }).toThrow("planId and planName must be present exactly when the live limits are");
  });

  it.each([
    ["plan ID", { planId: "b0000000-0000-4000-8000-000000000002" }, "item plan"],
    ["plan name", { planName: "Premium" }, "item plan"],
    [
      "remaining value",
      { remaining: 990 },
      "item [monthlyAllowance, maxUnitsPerRequest, remaining]",
    ],
    [
      "allowance",
      { monthlyAllowance: 10_000 },
      "item [monthlyAllowance, maxUnitsPerRequest, remaining]",
    ],
    ["used value", { used: 0 }, "item [userId, name, used]"],
  ])("rejects a wrong %s", (_label, change, what) => {
    expect(() => {
      checkListedUsage({ ...listed, ...change }, expectCurrent, "item");
    }).toThrow(`${what}: expected`);
  });

  it("rejects an item in the other form", () => {
    expect(() => {
      checkListedUsage(pastItem, expectCurrent, "item");
    }).toThrow(FormMismatch);
  });
});

describe("checkDecision", () => {
  const STARTER: Plan = {
    id: "a0000000-0000-4000-8000-000000000001",
    code: "starter",
    name: "Starter",
    scope: "ACCOUNT",
    monthlyAllowance: 10_000,
    maxUnitsPerRequest: 100,
  };
  const level = (plan: Plan, used: number) => ({
    planId: plan.id,
    planName: plan.name,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
    used,
    remaining: Math.max(0, plan.monthlyAllowance - used),
  });
  const expected: DecisionExpectation = {
    requestId: "run-rejected-1",
    userId: USER.id,
    units: 25,
    accepted: false,
    blockingRule: "MAX_UNITS_PER_REQUEST",
    blockingLevel: "USER",
    user: { plan: BASIC, used: 10 },
    account: { plan: STARTER, used: 10 },
  };
  const decision: Decision = {
    requestId: "run-rejected-1",
    userId: USER.id,
    units: 25,
    accepted: false,
    blockingRule: "MAX_UNITS_PER_REQUEST",
    blockingLevel: "USER",
    month: "2026-10",
    processedAt: "2026-10-14T10:00:00.000Z",
    account: level(STARTER, 10),
    user: level(BASIC, 10),
  };
  const LEVEL_FIELDS = "[planId, planName, monthlyAllowance, maxUnitsPerRequest, used, remaining]";

  it("accepts a decision matching the request, outcome, plans, usage and remaining", () => {
    expect(() => {
      checkDecision(decision, expected);
    }).not.toThrow();
  });

  it("rejects a response for another requestId", () => {
    expect(() => {
      checkDecision({ ...decision, requestId: "run-accepted-1" }, expected);
    }).toThrow(
      `decision run-rejected-1 [requestId, userId, units]: expected ["run-rejected-1","${USER.id}",25], got ["run-accepted-1","${USER.id}",25]`,
    );
  });

  it.each([
    ["user", { userId: "22222222-2222-4222-8222-000000000002" }],
    ["units", { units: 20 }],
  ])("rejects a rejected decision echoing the wrong %s", (_label, change) => {
    expect(() => {
      checkDecision({ ...decision, ...change }, expected);
    }).toThrow("decision run-rejected-1 [requestId, userId, units]");
  });

  it("rejects a rejection that changed usage", () => {
    const counted = { ...decision, user: level(BASIC, 35) };

    expect(() => {
      checkDecision(counted, expected);
    }).toThrow(
      `decision run-rejected-1 user ${LEVEL_FIELDS}: expected ["${BASIC.id}","Basic",1000,20,10,990], got ["${BASIC.id}","Basic",1000,20,35,965]`,
    );
  });

  it.each([
    ["the user level", "USER", "ACCOUNT"],
    ["the account level", "ACCOUNT", "USER"],
  ] as const)("rejects a rejection attributed to the wrong level (%s)", (_label, right, wrong) => {
    const rightLevel = { ...expected, blockingLevel: right };

    expect(() => {
      checkDecision({ ...decision, blockingLevel: right }, rightLevel);
    }).not.toThrow();
    expect(() => {
      checkDecision({ ...decision, blockingLevel: wrong }, rightLevel);
    }).toThrow(
      `decision run-rejected-1 outcome: expected [false,"MAX_UNITS_PER_REQUEST","${right}"]`,
    );
  });

  it.each([
    ["a wrong remaining allowance", { remaining: 9_000 }],
    ["another plan", { planId: "a0000000-0000-4000-8000-000000000002", planName: "Pro" }],
    ["changed limits", { monthlyAllowance: 35 }],
  ])("rejects an account level with %s", (_label, change) => {
    expect(() => {
      checkDecision({ ...decision, account: { ...decision.account, ...change } }, expected);
    }).toThrow(`decision run-rejected-1 account ${LEVEL_FIELDS}`);
  });

  it("expects zero remaining when usage exceeds a reduced allowance", () => {
    const capped: Plan = {
      ...STARTER,
      id: "c0000000-0000-4000-8000-000000000001",
      monthlyAllowance: 5,
    };

    expect(() => {
      checkDecision(
        { ...decision, account: { ...level(capped, 10), remaining: 0 } },
        { ...expected, account: { plan: capped, used: 10 } },
      );
    }).not.toThrow();
  });
});

describe("describeDecision", () => {
  const level = (planName: string, used: number, remaining: number) => ({
    planId: "p",
    planName,
    monthlyAllowance: used + remaining,
    maxUnitsPerRequest: 100,
    used,
    remaining,
  });
  const base = {
    requestId: "run-1",
    userId: USER.id,
    units: 5,
    month: "2026-10",
    processedAt: "2026-10-14T10:00:00.000Z",
    user: level("Premium", 25, 9_975),
    account: level("Example shared cap", 35, 0),
  };

  it("prints the outcome with each level's usage and remaining allowance", () => {
    expect(
      describeDecision({ ...base, accepted: true, blockingRule: null, blockingLevel: null }),
    ).toBe(
      'run-1: ACCEPTED 5 units | user "Premium" 25 used, 9975 remaining | account "Example shared cap" 35 used, 0 remaining',
    );
  });

  it("names the blocking rule and level of a rejection", () => {
    expect(
      describeDecision({
        ...base,
        accepted: false,
        blockingRule: "MONTHLY_ALLOWANCE",
        blockingLevel: "ACCOUNT",
      }),
    ).toBe(
      'run-1: REJECTED 5 units by ACCOUNT MONTHLY_ALLOWANCE | user "Premium" 25 used, 9975 remaining | account "Example shared cap" 35 used, 0 remaining',
    );
  });
});

describe("limitsOf", () => {
  it("shows both rules of a plan", () => {
    expect(limitsOf(BASIC)).toBe("1000/month, 20/request");
  });
});
