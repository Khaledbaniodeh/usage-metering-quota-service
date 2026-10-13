import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

const PLAN_IDS = {
  starter: "a0000000-0000-4000-8000-000000000001",
  pro: "a0000000-0000-4000-8000-000000000002",
  basic: "b0000000-0000-4000-8000-000000000001",
  premium: "b0000000-0000-4000-8000-000000000002",
};
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const PLAN_NOT_FOUND = { error: { code: "NOT_FOUND", message: "Plan not found" } };
const USER_NOT_FOUND = { error: { code: "NOT_FOUND", message: "User not found" } };
const SCOPE_MISMATCH = {
  error: {
    code: "PLAN_SCOPE_MISMATCH",
    message: "The plan scope does not match the assignment target",
  },
};

interface PlanSummary {
  id: string;
  code: string | null;
  name: string;
  scope: "ACCOUNT" | "USER";
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

interface Assignee {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  plan: PlanSummary;
}

let now = new Date("2026-10-13T12:00:00.000Z");
let clockReads = 0;
let integration: IntegrationApp;
let accountA: TestAccount;
let accountB: TestAccount;
let customAccountPlanA: PlanSummary;
let customUserPlanA: PlanSummary;
let customAccountPlanB: PlanSummary;
let customUserPlanB: PlanSummary;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({
    clock: () => {
      clockReads += 1;
      return now;
    },
  });
  accountA = await createTestAccount(integration.app, "Assign A");
  accountB = await createTestAccount(integration.app, "Assign B");
  customAccountPlanA = await createPlan(accountA, "A Team", "ACCOUNT");
  customUserPlanA = await createPlan(accountA, "A Seat", "USER");
  customAccountPlanB = await createPlan(accountB, "B Team", "ACCOUNT");
  customUserPlanB = await createPlan(accountB, "B Seat", "USER");
});

afterAll(async () => {
  await integration.close();
});

beforeEach(() => {
  // Every test starts later than anything created before it, so a changed updatedAt is visible.
  now = new Date(now.getTime() + 60_000);
});

async function createPlan(
  account: TestAccount,
  name: string,
  scope: "ACCOUNT" | "USER",
): Promise<PlanSummary> {
  const response = await authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/plans",
    payload: { name, scope, monthlyAllowance: 5_000, maxUnitsPerRequest: 50 },
  });
  expect(response.statusCode, response.body).toBe(201);
  const plan = response.json<PlanSummary>();
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    scope: plan.scope,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
  };
}

async function createUser(account: TestAccount, name = "Assignee"): Promise<Assignee> {
  const response = await authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/users",
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Assignee>();
}

function assignAccountPlan(account: TestAccount, payload: unknown) {
  return authenticatedRequest(integration.app, account, {
    method: "PUT",
    url: "/v1/account/plan",
    payload: payload as object,
  });
}

function assignUserPlan(account: TestAccount, userId: string, payload: unknown) {
  return authenticatedRequest(integration.app, account, {
    method: "PUT",
    url: `/v1/users/${userId}/plan`,
    payload: payload as object,
  });
}

async function readAccount(account: TestAccount): Promise<Assignee> {
  const response = await authenticatedRequest(integration.app, account, {
    method: "GET",
    url: "/v1/account",
  });
  expect(response.statusCode).toBe(200);
  return response.json<Assignee>();
}

async function storedAssignment(table: "accounts" | "users", id: string) {
  return withTestClient(async (client) => {
    const result = await client.query<{ plan_id: string; updated_at: Date }>(
      // The table name is one of two literals, never user input.
      `SELECT plan_id, updated_at FROM ${table} WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  });
}

describe("plan assignment requires authentication", () => {
  it.each([
    ["PUT", "/v1/account/plan"],
    ["PUT", `/v1/users/${UNKNOWN_ID}/plan`],
  ] as const)("%s %s without X-API-Key returns 401", async (method, url) => {
    const response = await integration.app.inject({
      method,
      url,
      payload: { planId: PLAN_IDS.pro },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });
});

describe("PUT /v1/account/plan", () => {
  it("switches the account to the predefined Pro plan", async () => {
    const account = await createTestAccount(integration.app, "Upgrader");
    const before = await readAccount(account);
    expect(before.plan.code).toBe("starter");

    const response = await assignAccountPlan(account, { planId: PLAN_IDS.pro });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...before,
      updatedAt: now.toISOString(),
      plan: {
        id: PLAN_IDS.pro,
        code: "pro",
        name: "Pro",
        scope: "ACCOUNT",
        monthlyAllowance: 100_000,
        maxUnitsPerRequest: 1_000,
      },
    });
    expect(await readAccount(account)).toEqual(response.json());
  });

  it("switches the account to its own custom ACCOUNT plan and back", async () => {
    const custom = await assignAccountPlan(accountA, { planId: customAccountPlanA.id });

    expect(custom.statusCode).toBe(200);
    expect(custom.json<Assignee>().plan).toEqual(customAccountPlanA);

    const back = await assignAccountPlan(accountA, { planId: PLAN_IDS.starter });

    expect(back.statusCode).toBe(200);
    expect(back.json<Assignee>().plan.code).toBe("starter");
  });

  it("reads the clock once per assignment", async () => {
    clockReads = 0;

    const response = await assignAccountPlan(accountA, { planId: PLAN_IDS.pro });

    expect(response.statusCode).toBe(200);
    expect(clockReads).toBe(1);
  });

  it("treats reassigning the current plan as a successful no-op that keeps updatedAt", async () => {
    const first = await assignAccountPlan(accountA, { planId: PLAN_IDS.pro });
    const stored = await storedAssignment("accounts", accountA.id);
    now = new Date(now.getTime() + 60_000);

    const again = await assignAccountPlan(accountA, { planId: PLAN_IDS.pro });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await storedAssignment("accounts", accountA.id)).toEqual(stored);
  });

  it.each([
    ["the predefined Basic plan", () => PLAN_IDS.basic],
    ["the predefined Premium plan", () => PLAN_IDS.premium],
    ["its own custom USER plan", () => customUserPlanA.id],
  ])("refuses %s with 409 PLAN_SCOPE_MISMATCH, changing nothing", async (_label, planId) => {
    const before = await storedAssignment("accounts", accountA.id);

    const response = await assignAccountPlan(accountA, { planId: planId() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(SCOPE_MISMATCH);
    expect(await storedAssignment("accounts", accountA.id)).toEqual(before);
  });

  it("answers another account's plan exactly like an unknown plan, changing nothing", async () => {
    const before = await storedAssignment("accounts", accountA.id);

    const foreign = await assignAccountPlan(accountA, { planId: customAccountPlanB.id });
    const foreignUserPlan = await assignAccountPlan(accountA, { planId: customUserPlanB.id });
    const unknown = await assignAccountPlan(accountA, { planId: UNKNOWN_ID });

    for (const response of [foreign, foreignUserPlan, unknown]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(PLAN_NOT_FOUND);
    }
    expect(foreign.body).not.toContain("B Team");
    expect(await storedAssignment("accounts", accountA.id)).toEqual(before);
  });

  it.each([
    ["a missing plan ID", {}],
    ["a malformed plan ID", { planId: "pro" }],
    ["a numeric plan ID", { planId: 2 }],
    ["a null plan ID", { planId: null }],
    ["an extra property", { planId: PLAN_IDS.pro, accountId: UNKNOWN_ID }],
  ])("rejects %s with 400 VALIDATION_ERROR, changing nothing", async (_label, payload) => {
    const before = await storedAssignment("accounts", accountA.id);

    const response = await assignAccountPlan(accountA, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    expect(await storedAssignment("accounts", accountA.id)).toEqual(before);
  });
});

describe("PUT /v1/users/:userId/plan", () => {
  it("switches a user to the predefined Premium plan and back to Basic", async () => {
    const user = await createUser(accountA, "Climber");

    const premium = await assignUserPlan(accountA, user.id, { planId: PLAN_IDS.premium });

    expect(premium.statusCode).toBe(200);
    expect(premium.json()).toEqual({
      ...user,
      updatedAt: now.toISOString(),
      plan: {
        id: PLAN_IDS.premium,
        code: "premium",
        name: "Premium",
        scope: "USER",
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
      },
    });
    const read = await authenticatedRequest(integration.app, accountA, {
      method: "GET",
      url: `/v1/users/${user.id}`,
    });
    expect(read.json()).toEqual(premium.json());

    now = new Date(now.getTime() + 60_000);
    const basic = await assignUserPlan(accountA, user.id, { planId: PLAN_IDS.basic });

    expect(basic.statusCode).toBe(200);
    expect(basic.json<Assignee>().plan.code).toBe("basic");
    expect(basic.json<Assignee>().updatedAt).toBe(now.toISOString());
  });

  it("switches a user to the account's own custom USER plan", async () => {
    const user = await createUser(accountA);

    const response = await assignUserPlan(accountA, user.id, { planId: customUserPlanA.id });

    expect(response.statusCode).toBe(200);
    expect(response.json<Assignee>().plan).toEqual(customUserPlanA);
  });

  it("reads the clock once per assignment", async () => {
    const user = await createUser(accountA);
    clockReads = 0;

    const response = await assignUserPlan(accountA, user.id, { planId: PLAN_IDS.premium });

    expect(response.statusCode).toBe(200);
    expect(clockReads).toBe(1);
  });

  it("treats reassigning the current plan as a successful no-op that keeps updatedAt", async () => {
    const user = await createUser(accountA);
    now = new Date(now.getTime() + 60_000);

    const response = await assignUserPlan(accountA, user.id, { planId: PLAN_IDS.basic });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(user);
  });

  it.each([
    ["the predefined Starter plan", () => PLAN_IDS.starter],
    ["the predefined Pro plan", () => PLAN_IDS.pro],
    ["the account's own custom ACCOUNT plan", () => customAccountPlanA.id],
  ])("refuses %s with 409 PLAN_SCOPE_MISMATCH, changing nothing", async (_label, planId) => {
    const user = await createUser(accountA);
    const before = await storedAssignment("users", user.id);

    const response = await assignUserPlan(accountA, user.id, { planId: planId() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(SCOPE_MISMATCH);
    expect(await storedAssignment("users", user.id)).toEqual(before);
  });

  it("answers another account's plan exactly like an unknown plan, changing nothing", async () => {
    const user = await createUser(accountA);
    const before = await storedAssignment("users", user.id);

    const foreign = await assignUserPlan(accountA, user.id, { planId: customUserPlanB.id });
    const unknown = await assignUserPlan(accountA, user.id, { planId: UNKNOWN_ID });

    for (const response of [foreign, unknown]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(PLAN_NOT_FOUND);
    }
    expect(foreign.body).not.toContain("B Seat");
    expect(await storedAssignment("users", user.id)).toEqual(before);
  });

  it.each([
    ["a predefined user plan", () => PLAN_IDS.premium],
    ["the owner's custom plan", () => customUserPlanB.id],
    ["the caller's custom plan", () => customUserPlanA.id],
    ["a plan of the wrong scope", () => PLAN_IDS.pro],
    ["an unknown plan", () => UNKNOWN_ID],
  ])(
    "answers another account's user exactly like an unknown user, with %s",
    async (_label, planId) => {
      const foreignUser = await createUser(accountB, "Not Yours");
      const before = await storedAssignment("users", foreignUser.id);

      const foreign = await assignUserPlan(accountA, foreignUser.id, { planId: planId() });
      const unknown = await assignUserPlan(accountA, UNKNOWN_ID, { planId: planId() });

      for (const response of [foreign, unknown]) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual(USER_NOT_FOUND);
      }
      expect(foreign.body).not.toContain("Not Yours");
      expect(await storedAssignment("users", foreignUser.id)).toEqual(before);
    },
  );

  it.each([
    ["a missing plan ID", {}],
    ["a malformed plan ID", { planId: "premium" }],
    ["an extra property", { planId: PLAN_IDS.premium, userId: UNKNOWN_ID }],
  ])("rejects %s with 400 VALIDATION_ERROR, changing nothing", async (_label, payload) => {
    const user = await createUser(accountA);
    const before = await storedAssignment("users", user.id);

    const response = await assignUserPlan(accountA, user.id, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    expect(await storedAssignment("users", user.id)).toEqual(before);
  });

  it("rejects a malformed user ID with 400", async () => {
    const response = await assignUserPlan(accountA, "not-a-uuid", { planId: PLAN_IDS.premium });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});
