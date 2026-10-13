import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

const PREDEFINED_CREATED_AT = "2026-10-12T00:00:00.000Z";
const PREDEFINED = {
  starter: {
    id: "a0000000-0000-4000-8000-000000000001",
    code: "starter",
    name: "Starter",
    scope: "ACCOUNT",
    monthlyAllowance: 10_000,
    maxUnitsPerRequest: 100,
    createdAt: PREDEFINED_CREATED_AT,
    updatedAt: PREDEFINED_CREATED_AT,
  },
  pro: {
    id: "a0000000-0000-4000-8000-000000000002",
    code: "pro",
    name: "Pro",
    scope: "ACCOUNT",
    monthlyAllowance: 100_000,
    maxUnitsPerRequest: 1_000,
    createdAt: PREDEFINED_CREATED_AT,
    updatedAt: PREDEFINED_CREATED_AT,
  },
  basic: {
    id: "b0000000-0000-4000-8000-000000000001",
    code: "basic",
    name: "Basic",
    scope: "USER",
    monthlyAllowance: 1_000,
    maxUnitsPerRequest: 20,
    createdAt: PREDEFINED_CREATED_AT,
    updatedAt: PREDEFINED_CREATED_AT,
  },
  premium: {
    id: "b0000000-0000-4000-8000-000000000002",
    code: "premium",
    name: "Premium",
    scope: "USER",
    monthlyAllowance: 10_000,
    maxUnitsPerRequest: 100,
    createdAt: PREDEFINED_CREATED_AT,
    updatedAt: PREDEFINED_CREATED_AT,
  },
};

interface Plan {
  id: string;
  code: string | null;
  name: string;
  scope: "ACCOUNT" | "USER";
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  createdAt: string;
  updatedAt: string;
}

let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let accountA: TestAccount;
let accountB: TestAccount;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
  accountA = await createTestAccount(integration.app, "Plans A");
  accountB = await createTestAccount(integration.app, "Plans B");
});

afterAll(async () => {
  await integration.close();
});

function listPlans(account: TestAccount, query = "") {
  return authenticatedRequest(integration.app, account, {
    method: "GET",
    url: `/v1/plans${query}`,
  });
}

function createPlan(account: TestAccount, payload: unknown) {
  return authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/plans",
    payload: payload as object,
  });
}

function updatePlan(account: TestAccount, planId: string, payload: unknown) {
  return authenticatedRequest(integration.app, account, {
    method: "PATCH",
    url: `/v1/plans/${planId}`,
    payload: payload as object,
  });
}

async function createCustomPlan(
  account: TestAccount,
  overrides: Partial<Pick<Plan, "name" | "scope" | "monthlyAllowance" | "maxUnitsPerRequest">> = {},
): Promise<Plan> {
  const response = await createPlan(account, {
    name: "Custom",
    scope: "USER",
    monthlyAllowance: 500,
    maxUnitsPerRequest: 10,
    ...overrides,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Plan>();
}

async function storedPlan(planId: string) {
  return withTestClient(async (client) => {
    const result = await client.query<{
      owner_account_id: string | null;
      name: string;
      monthly_allowance: number;
      max_units_per_request: number;
      updated_at: Date;
    }>(
      `SELECT owner_account_id, name, monthly_allowance, max_units_per_request, updated_at
       FROM plans WHERE id = $1`,
      [planId],
    );
    return result.rows[0];
  });
}

async function planCount(): Promise<number> {
  return withTestClient(async (client) => {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM plans",
    );
    return result.rows[0]?.count ?? -1;
  });
}

describe("plan endpoints require authentication", () => {
  it.each([
    ["GET", "/v1/plans"],
    ["POST", "/v1/plans"],
    ["PATCH", `/v1/plans/${PREDEFINED.starter.id}`],
  ] as const)("%s %s without X-API-Key returns 401", async (method, url) => {
    const response = await integration.app.inject({ method, url, payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /v1/plans", () => {
  it("lists exactly the four predefined plans for an account without custom plans", async () => {
    const fresh = await createTestAccount(integration.app, "No Custom Plans");

    const response = await listPlans(fresh);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plans: [PREDEFINED.starter, PREDEFINED.pro, PREDEFINED.basic, PREDEFINED.premium],
    });
  });

  it.each([
    ["ACCOUNT", [PREDEFINED.starter, PREDEFINED.pro]],
    ["USER", [PREDEFINED.basic, PREDEFINED.premium]],
  ] as const)("filters by scope=%s", async (scope, expected) => {
    const fresh = await createTestAccount(integration.app, `Filter ${scope}`);

    const response = await listPlans(fresh, `?scope=${scope}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plans: expected });
  });

  it.each([
    ["a lower-case scope", "?scope=account"],
    ["an unknown scope", "?scope=TEAM"],
    ["a repeated scope", "?scope=ACCOUNT&scope=USER"],
    ["an unknown query parameter", "?owner=someone"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, query) => {
    const response = await listPlans(accountA, query);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /v1/plans", () => {
  it.each(["ACCOUNT", "USER"] as const)(
    "creates a custom %s plan owned by the authenticated account",
    async (scope) => {
      const response = await createPlan(accountA, {
        name: `Custom ${scope}`,
        scope,
        monthlyAllowance: 2_500,
        maxUnitsPerRequest: 25,
      });

      expect(response.statusCode).toBe(201);
      const plan = response.json<Plan>();
      expect(plan).toEqual({
        id: expect.any(String) as unknown,
        code: null,
        name: `Custom ${scope}`,
        scope,
        monthlyAllowance: 2_500,
        maxUnitsPerRequest: 25,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      expect((await storedPlan(plan.id))?.owner_account_id).toBe(accountA.id);
    },
  );

  it.each([
    ["an owner account ID", { ownerAccountId: "00000000-0000-4000-8000-000000000000" }],
    ["an account ID", { accountId: "00000000-0000-4000-8000-000000000000" }],
    ["a predefined code", { code: "starter" }],
    ["an ID", { id: "00000000-0000-4000-8000-000000000000" }],
  ])("rejects a body that tries to set %s, creating nothing", async (_label, extra) => {
    const before = await planCount();

    const response = await createPlan(accountA, {
      name: "Hijack",
      scope: "USER",
      monthlyAllowance: 10,
      maxUnitsPerRequest: 1,
      ...extra,
    });

    expect(response.statusCode).toBe(400);
    expect(await planCount()).toBe(before);
  });

  it.each([
    ["the minimum", 1, 1],
    ["the maximum", 1_000_000_000, 1_000_000_000],
  ])("accepts limits at %s", async (_label, monthlyAllowance, maxUnitsPerRequest) => {
    const plan = await createCustomPlan(accountA, { monthlyAllowance, maxUnitsPerRequest });

    expect(plan).toMatchObject({ monthlyAllowance, maxUnitsPerRequest });
  });

  it.each([
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a numeric string", "10"],
    ["a value above the maximum", 1_000_000_001],
    ["null", null],
  ])("rejects %s for either limit, creating nothing", async (_label, value) => {
    const before = await planCount();

    for (const field of ["monthlyAllowance", "maxUnitsPerRequest"]) {
      const response = await createPlan(accountA, {
        name: "Bad Limit",
        scope: "USER",
        monthlyAllowance: 10,
        maxUnitsPerRequest: 1,
        [field]: value,
      });
      expect(response.statusCode, `${field}=${JSON.stringify(value)}`).toBe(400);
    }
    expect(await planCount()).toBe(before);
  });

  it.each([
    ["a missing scope", { name: "No Scope", monthlyAllowance: 10, maxUnitsPerRequest: 1 }],
    [
      "an invalid scope",
      { name: "Bad", scope: "TEAM", monthlyAllowance: 10, maxUnitsPerRequest: 1 },
    ],
    ["a missing limit", { name: "No Limit", scope: "USER", monthlyAllowance: 10 }],
    ["an empty name", { name: "", scope: "USER", monthlyAllowance: 10, maxUnitsPerRequest: 1 }],
    [
      "an untrimmed name",
      { name: " Gold", scope: "USER", monthlyAllowance: 10, maxUnitsPerRequest: 1 },
    ],
    [
      "a NUL in the name",
      { name: "Go\u0000ld", scope: "USER", monthlyAllowance: 10, maxUnitsPerRequest: 1 },
    ],
    [
      "a line separator in the name",
      { name: "Go ld", scope: "USER", monthlyAllowance: 10, maxUnitsPerRequest: 1 },
    ],
    [
      "a 101-character name",
      { name: "x".repeat(101), scope: "USER", monthlyAllowance: 10, maxUnitsPerRequest: 1 },
    ],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, payload) => {
    const response = await createPlan(accountA, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts a Unicode plan name", async () => {
    const plan = await createCustomPlan(accountA, { name: "Plan Ünïcødé 金" });

    expect(plan.name).toBe("Plan Ünïcødé 金");
  });
});

describe("custom plan visibility", () => {
  it("lists an account's own custom plans after the predefined ones, never another account's", async () => {
    const owner = await createTestAccount(integration.app, "Owner");
    const other = await createTestAccount(integration.app, "Other");
    const first = await createCustomPlan(owner, { name: "First", scope: "ACCOUNT" });
    now = new Date("2026-10-13T12:00:01.000Z");
    const second = await createCustomPlan(owner, { name: "Second", scope: "USER" });

    const ownerPlans = (await listPlans(owner)).json<{ plans: Plan[] }>().plans;
    const otherPlans = (await listPlans(other)).json<{ plans: Plan[] }>().plans;

    expect(ownerPlans.map((plan) => plan.id)).toEqual([
      PREDEFINED.starter.id,
      PREDEFINED.pro.id,
      PREDEFINED.basic.id,
      PREDEFINED.premium.id,
      first.id,
      second.id,
    ]);
    expect(otherPlans.map((plan) => plan.id)).not.toContain(first.id);
    expect(otherPlans.map((plan) => plan.id)).not.toContain(second.id);
    expect((await listPlans(owner, "?scope=USER")).json<{ plans: Plan[] }>().plans).toContainEqual(
      second,
    );
  });
});

describe("PATCH /v1/plans/:planId", () => {
  it("updates the name and limits of the account's own custom plan", async () => {
    now = new Date("2026-10-13T13:00:00.000Z");
    const plan = await createCustomPlan(accountA, { name: "Silver", scope: "USER" });
    now = new Date("2026-10-13T14:30:00.000Z");

    const response = await updatePlan(accountA, plan.id, {
      name: "Silver Plus",
      monthlyAllowance: 750,
      maxUnitsPerRequest: 15,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...plan,
      name: "Silver Plus",
      monthlyAllowance: 750,
      maxUnitsPerRequest: 15,
      updatedAt: "2026-10-13T14:30:00.000Z",
    });
  });

  it("changes only the fields that are sent", async () => {
    const plan = await createCustomPlan(accountA, { name: "Partial", monthlyAllowance: 300 });

    const response = await updatePlan(accountA, plan.id, { maxUnitsPerRequest: 7 });

    expect(response.json()).toMatchObject({
      name: "Partial",
      monthlyAllowance: 300,
      maxUnitsPerRequest: 7,
    });
  });

  it.each([
    ["an empty body", {}],
    ["a scope change", { scope: "ACCOUNT" }],
    ["a code", { code: "starter" }],
    ["a limit of zero", { monthlyAllowance: 0 }],
    ["a limit above the maximum", { maxUnitsPerRequest: 1_000_000_001 }],
    ["an untrimmed name", { name: "Padded " }],
  ])("rejects %s with 400 and leaves the plan unchanged", async (_label, payload) => {
    const plan = await createCustomPlan(accountA, { name: "Stable" });
    const before = await storedPlan(plan.id);

    const response = await updatePlan(accountA, plan.id, payload);

    expect(response.statusCode).toBe(400);
    expect(await storedPlan(plan.id)).toEqual(before);
  });

  it("refuses to update a predefined plan with 409 PLAN_READ_ONLY", async () => {
    const response = await updatePlan(accountA, PREDEFINED.basic.id, { monthlyAllowance: 1 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "PLAN_READ_ONLY", message: "Predefined plans are read-only" },
    });
    expect((await listPlans(accountA, "?scope=USER")).json<{ plans: Plan[] }>().plans[0]).toEqual(
      PREDEFINED.basic,
    );
  });

  it("answers another account's plan exactly like an unknown plan, changing nothing", async () => {
    const foreign = await createCustomPlan(accountB, { name: "B Only" });
    const before = await storedPlan(foreign.id);

    const foreignResponse = await updatePlan(accountA, foreign.id, { name: "Stolen" });
    const unknownResponse = await updatePlan(accountA, "00000000-0000-4000-8000-000000000000", {
      name: "Ghost",
    });

    expect(foreignResponse.statusCode).toBe(404);
    expect(foreignResponse.body).toBe(unknownResponse.body);
    expect(foreignResponse.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Plan not found" },
    });
    expect(await storedPlan(foreign.id)).toEqual(before);
  });

  it("rejects a malformed plan ID with 400", async () => {
    const response = await updatePlan(accountA, "not-a-uuid", { name: "X" });

    expect(response.statusCode).toBe(400);
  });
});
