import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  assignAccountPlan,
  assignUserPlan,
  countCounterRows,
  countDecisions,
  createTestPlan,
  createTestUser,
  PREDEFINED_PLAN_IDS,
  readCounters,
  type TestUser,
} from "../../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

const OCTOBER = "2026-10-01";
const UNKNOWN_USER_ID = "00000000-0000-4000-8000-000000000000";

interface DecisionBody {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  blockingRule: string | null;
  blockingLevel: string | null;
  month: string;
  processedAt: string;
  account: { planId: string; planName: string; used: number; remaining: number };
  user: { planId: string; planName: string; used: number; remaining: number };
}

let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let requestSequence = 0;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
});

afterAll(async () => {
  await integration.close();
});

function nextRequestId(): string {
  requestSequence += 1;
  return `req-${String(requestSequence)}`;
}

function consume(account: TestAccount, payload: unknown) {
  return authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/consume",
    payload: payload as object,
  });
}

async function consumeOk(
  account: TestAccount,
  userId: string,
  units: number,
  requestId = nextRequestId(),
): Promise<DecisionBody> {
  const response = await consume(account, { userId, units, requestId });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DecisionBody>();
}

/** A fresh account with one Basic user, so counters start at zero in every test. */
async function freshTenant(name: string): Promise<{ account: TestAccount; user: TestUser }> {
  const account = await createTestAccount(integration.app, name);
  const user = await createTestUser(integration.app, account, `${name} User`);
  return { account, user };
}

describe("authentication", () => {
  it.each([
    ["no key", {}],
    ["an unknown key", { "x-api-key": `umqs_${"A".repeat(43)}` }],
  ])("rejects a consume with %s and writes nothing", async (_label, headers) => {
    const { account, user } = await freshTenant("Auth");

    const response = await integration.app.inject({
      method: "POST",
      url: "/v1/consume",
      headers,
      payload: { userId: user.id, units: 1, requestId: "auth-1" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "A valid API key is required" },
    });
    expect(await countDecisions(account.id)).toBe(0);
    expect(await countCounterRows(account.id)).toBe(0);
  });
});

describe("accepted requests", () => {
  it("returns 200 with the stored decision and counts the units at both levels", async () => {
    const { account, user } = await freshTenant("Accept");

    const response = await consume(account, { userId: user.id, units: 10, requestId: "doc-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requestId: "doc-1",
      userId: user.id,
      units: 10,
      accepted: true,
      blockingRule: null,
      blockingLevel: null,
      month: "2026-10",
      processedAt: "2026-10-13T12:00:00.000Z",
      account: {
        planId: PREDEFINED_PLAN_IDS.starter,
        planName: "Starter",
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
        used: 10,
        remaining: 9_990,
      },
      user: {
        planId: PREDEFINED_PLAN_IDS.basic,
        planName: "Basic",
        monthlyAllowance: 1_000,
        maxUnitsPerRequest: 20,
        used: 10,
        remaining: 990,
      },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 10, user: 10 });
  });

  it("accepts exactly the user's per-request limit", async () => {
    const { account, user } = await freshTenant("Per Request Boundary");

    const decision = await consumeOk(account, user.id, 20);

    expect(decision.accepted).toBe(true);
  });

  it("accepts a request that uses exactly the rest of the monthly allowance, then rejects one more unit", async () => {
    const { account, user } = await freshTenant("Monthly Boundary");
    const smallPlan = await createTestPlan(integration.app, account, {
      name: "Thirty",
      scope: "USER",
      monthlyAllowance: 30,
      maxUnitsPerRequest: 20,
    });
    await assignUserPlan(integration.app, account, user.id, smallPlan);

    await consumeOk(account, user.id, 20);
    const exact = await consumeOk(account, user.id, 10);
    const beyond = await consumeOk(account, user.id, 1);

    expect(exact).toMatchObject({ accepted: true, user: { used: 30, remaining: 0 } });
    expect(beyond).toMatchObject({
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "USER",
      user: { used: 30, remaining: 0 },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 30, user: 30 });
  });
});

describe("rejections name the first blocking rule and count nothing", () => {
  it("USER MAX_UNITS_PER_REQUEST: 25 units on a 20-per-request user plan", async () => {
    const { account, user } = await freshTenant("User Per Request");

    const decision = await consumeOk(account, user.id, 25);

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
      account: { used: 0, remaining: 10_000 },
      user: { used: 0, remaining: 1_000 },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 0, user: 0 });
  });

  it("ACCOUNT MAX_UNITS_PER_REQUEST: above the account's limit but within the user's", async () => {
    const { account, user } = await freshTenant("Account Per Request");
    const accountPlan = await createTestPlan(integration.app, account, {
      name: "Narrow Account",
      scope: "ACCOUNT",
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 50,
    });
    await assignAccountPlan(integration.app, account, accountPlan);
    await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);

    const decision = await consumeOk(account, user.id, 51);

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "ACCOUNT",
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 0, user: 0 });
  });

  it("USER MONTHLY_ALLOWANCE: the user's allowance is exhausted", async () => {
    const { account, user } = await freshTenant("User Monthly");
    const userPlan = await createTestPlan(integration.app, account, {
      name: "Tiny Seat",
      scope: "USER",
      monthlyAllowance: 25,
      maxUnitsPerRequest: 20,
    });
    await assignUserPlan(integration.app, account, user.id, userPlan);
    await consumeOk(account, user.id, 20);

    const decision = await consumeOk(account, user.id, 6);

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "USER",
      user: { used: 20, remaining: 5 },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 20, user: 20 });
  });

  it("ACCOUNT MONTHLY_ALLOWANCE: only five shared units left for a 10-unit request", async () => {
    const { account, user } = await freshTenant("Account Monthly");
    const second = await createTestUser(integration.app, account, "Second");
    const accountPlan = await createTestPlan(integration.app, account, {
      name: "Shared Twenty Five",
      scope: "ACCOUNT",
      monthlyAllowance: 25,
      maxUnitsPerRequest: 100,
    });
    await assignAccountPlan(integration.app, account, accountPlan);
    await consumeOk(account, user.id, 20);

    const decision = await consumeOk(account, second.id, 10);

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "ACCOUNT",
      account: { used: 20, remaining: 5 },
      user: { used: 0, remaining: 1_000 },
    });
    expect(await readCounters(account.id, second.id, OCTOBER)).toEqual({ account: 20, user: 0 });
  });

  it("reports the user's per-request rule when every rule fails", async () => {
    const { account, user } = await freshTenant("All Fail");
    const accountPlan = await createTestPlan(integration.app, account, {
      name: "Exhausted",
      scope: "ACCOUNT",
      monthlyAllowance: 20,
      maxUnitsPerRequest: 20,
    });
    await consumeOk(account, user.id, 20);
    await assignAccountPlan(integration.app, account, accountPlan);

    const decision = await consumeOk(account, user.id, 1_500);

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
    });
  });

  it("shows zero remaining when an allowance was reduced below usage, and keeps rejecting", async () => {
    const { account, user } = await freshTenant("Reduced");
    const userPlan = await createTestPlan(integration.app, account, {
      name: "Shrinking",
      scope: "USER",
      monthlyAllowance: 100,
      maxUnitsPerRequest: 20,
    });
    await assignUserPlan(integration.app, account, user.id, userPlan);
    await consumeOk(account, user.id, 20);
    const patch = await authenticatedRequest(integration.app, account, {
      method: "PATCH",
      url: `/v1/plans/${userPlan}`,
      payload: { monthlyAllowance: 10 },
    });
    expect(patch.statusCode).toBe(200);

    const decision = await consumeOk(account, user.id, 1);

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "USER",
      user: { monthlyAllowance: 10, used: 20, remaining: 0 },
    });
  });
});

describe("request validation", () => {
  const VALID_USER = "11111111-1111-4111-8111-111111111111";

  it.each([
    ["a missing userId", { units: 1, requestId: "v-1" }],
    ["a malformed userId", { userId: "not-a-uuid", units: 1, requestId: "v-1" }],
    ["a numeric userId", { userId: 42, units: 1, requestId: "v-1" }],
    ["missing units", { userId: VALID_USER, requestId: "v-1" }],
    ["null units", { userId: VALID_USER, units: null, requestId: "v-1" }],
    ["stringified units", { userId: VALID_USER, units: "1", requestId: "v-1" }],
    ["fractional units", { userId: VALID_USER, units: 1.5, requestId: "v-1" }],
    ["zero units", { userId: VALID_USER, units: 0, requestId: "v-1" }],
    ["negative units", { userId: VALID_USER, units: -1, requestId: "v-1" }],
    ["units above 1,000,000,000", { userId: VALID_USER, units: 1_000_000_001, requestId: "v-1" }],
    ["boolean units", { userId: VALID_USER, units: true, requestId: "v-1" }],
    ["a missing requestId", { userId: VALID_USER, units: 1 }],
    ["an empty requestId", { userId: VALID_USER, units: 1, requestId: "" }],
    ["a requestId of 129 characters", { userId: VALID_USER, units: 1, requestId: "r".repeat(129) }],
    ["a requestId with a space", { userId: VALID_USER, units: 1, requestId: "a b" }],
    ["a requestId with a slash", { userId: VALID_USER, units: 1, requestId: "a/b" }],
    ["a requestId with a newline", { userId: VALID_USER, units: 1, requestId: "a\n" }],
    ["a numeric requestId", { userId: VALID_USER, units: 1, requestId: 7 }],
    ["an unknown field", { userId: VALID_USER, units: 1, requestId: "v-1", accountId: VALID_USER }],
    ["an array body", [{ userId: VALID_USER, units: 1, requestId: "v-1" }]],
  ])("rejects %s with 400 VALIDATION_ERROR and writes nothing", async (_label, payload) => {
    const { account } = await freshTenant("Validation");

    const response = await consume(account, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    expect(await countDecisions(account.id)).toBe(0);
    expect(await countCounterRows(account.id)).toBe(0);
  });

  it("accepts a requestId of exactly 128 allowed characters", async () => {
    const { account, user } = await freshTenant("Long Request ID");
    const requestId = `A-z_0.9:${"x".repeat(120)}`;

    const decision = await consumeOk(account, user.id, 1, requestId);

    expect(decision.requestId).toBe(requestId);
  });

  it("rejects malformed JSON with 400 and a non-JSON body with 415", async () => {
    const { account } = await freshTenant("Bad Body");

    const malformed = await authenticatedRequest(integration.app, account, {
      method: "POST",
      url: "/v1/consume",
      headers: { "content-type": "application/json" },
      payload: '{"userId":',
    });
    const xml = await authenticatedRequest(integration.app, account, {
      method: "POST",
      url: "/v1/consume",
      headers: { "content-type": "application/xml" },
      payload: "<consume/>",
    });

    expect(malformed.statusCode).toBe(400);
    expect(xml.statusCode).toBe(415);
    expect(await countDecisions(account.id)).toBe(0);
  });
});

describe("unknown and foreign users", () => {
  it("answers both with the same 404 and creates no counters or decisions", async () => {
    const { account } = await freshTenant("Caller");
    const { account: owner, user: foreignUser } = await freshTenant("Owner");

    const foreign = await consume(account, { userId: foreignUser.id, units: 1, requestId: "x-1" });
    const unknown = await consume(account, { userId: UNKNOWN_USER_ID, units: 1, requestId: "x-1" });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    expect(foreign.json()).toEqual({ error: { code: "NOT_FOUND", message: "User not found" } });
    for (const tenant of [account, owner]) {
      expect(await countDecisions(tenant.id)).toBe(0);
      expect(await countCounterRows(tenant.id)).toBe(0);
    }
  });
});

describe("idempotent retries", () => {
  it("replays an accepted decision byte-for-byte and counts it once", async () => {
    const { account, user } = await freshTenant("Replay Accepted");
    const first = await consume(account, { userId: user.id, units: 5, requestId: "same" });
    now = new Date(now.getTime() + 1_000);

    const retry = await consume(account, { userId: user.id, units: 5, requestId: "same" });

    expect(retry.statusCode).toBe(200);
    expect(retry.body).toBe(first.body);
    expect(retry.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 5, user: 5 });
    expect(await countDecisions(account.id, "same")).toBe(1);
  });

  it("replays a rejected decision byte-for-byte, even when it would now be accepted", async () => {
    const { account, user } = await freshTenant("Replay Rejected");
    const first = await consume(account, { userId: user.id, units: 25, requestId: "big" });
    await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);

    const retry = await consume(account, { userId: user.id, units: 25, requestId: "big" });

    expect(first.json<DecisionBody>().accepted).toBe(false);
    expect(retry.body).toBe(first.body);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 0, user: 0 });
  });

  it.each([
    ["a different user", "other-user"],
    ["different units", "other-units"],
  ])(
    "rejects reuse with %s as 409 IDEMPOTENCY_CONFLICT, changing nothing",
    async (_label, kind) => {
      const { account, user } = await freshTenant("Conflict");
      const second = await createTestUser(integration.app, account, "Second");
      await consumeOk(account, user.id, 5, "key-1");

      const response = await consume(
        account,
        kind === "other-user"
          ? { userId: second.id, units: 5, requestId: "key-1" }
          : { userId: user.id, units: 6, requestId: "key-1" },
      );

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "The request ID was already used with a different user or number of units",
        },
      });
      expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 5, user: 5 });
      expect(await countDecisions(account.id)).toBe(1);
    },
  );

  it("lets different accounts use the same requestId independently", async () => {
    const a = await freshTenant("Same Key A");
    const b = await freshTenant("Same Key B");

    const first = await consumeOk(a.account, a.user.id, 3, "shared-key");
    const second = await consumeOk(b.account, b.user.id, 7, "shared-key");

    expect(first).toMatchObject({ accepted: true, units: 3, userId: a.user.id });
    expect(second).toMatchObject({ accepted: true, units: 7, userId: b.user.id });
    expect(await readCounters(a.account.id, a.user.id, OCTOBER)).toEqual({ account: 3, user: 3 });
    expect(await readCounters(b.account.id, b.user.id, OCTOBER)).toEqual({ account: 7, user: 7 });
  });
});

describe("snapshots survive later plan changes", () => {
  it("stores the exact plan IDs, names and all four limits", async () => {
    const { account, user } = await freshTenant("Snapshot");
    const accountPlan = await createTestPlan(integration.app, account, {
      name: "Team Gold",
      scope: "ACCOUNT",
      monthlyAllowance: 777,
      maxUnitsPerRequest: 77,
    });
    const userPlan = await createTestPlan(integration.app, account, {
      name: "Seat Silver",
      scope: "USER",
      monthlyAllowance: 666,
      maxUnitsPerRequest: 66,
    });
    await assignAccountPlan(integration.app, account, accountPlan);
    await assignUserPlan(integration.app, account, user.id, userPlan);

    await consumeOk(account, user.id, 6, "snap");

    const stored = await withTestClient(async (client) => {
      const result = await client.query(
        `SELECT account_plan_id, account_plan_name, account_monthly_allowance,
                account_max_units_per_request, account_used_before,
                user_plan_id, user_plan_name, user_monthly_allowance,
                user_max_units_per_request, user_used_before, month, processed_at
         FROM consume_decisions WHERE account_id = $1 AND request_id = 'snap'`,
        [account.id],
      );
      return result.rows[0] as unknown;
    });
    expect(stored).toEqual({
      account_plan_id: accountPlan,
      account_plan_name: "Team Gold",
      account_monthly_allowance: 777,
      account_max_units_per_request: 77,
      account_used_before: 0,
      user_plan_id: userPlan,
      user_plan_name: "Seat Silver",
      user_monthly_allowance: 666,
      user_max_units_per_request: 66,
      user_used_before: 0,
      month: OCTOBER,
      processed_at: now,
    });
  });

  it("replays the original response after the plan is renamed and its limits change", async () => {
    const { account, user } = await freshTenant("Replay After Update");
    const userPlan = await createTestPlan(integration.app, account, {
      name: "Before",
      scope: "USER",
      monthlyAllowance: 500,
      maxUnitsPerRequest: 50,
    });
    await assignUserPlan(integration.app, account, user.id, userPlan);
    const first = await consume(account, { userId: user.id, units: 40, requestId: "upd" });
    const patch = await authenticatedRequest(integration.app, account, {
      method: "PATCH",
      url: `/v1/plans/${userPlan}`,
      payload: { name: "After", monthlyAllowance: 10, maxUnitsPerRequest: 5 },
    });
    expect(patch.statusCode).toBe(200);

    const retry = await consume(account, { userId: user.id, units: 40, requestId: "upd" });

    expect(retry.body).toBe(first.body);
    expect(retry.json<DecisionBody>().user.planName).toBe("Before");
  });

  it("replays the original response after the account and user switch plans", async () => {
    const { account, user } = await freshTenant("Replay After Switch");
    const first = await consume(account, { userId: user.id, units: 15, requestId: "sw" });
    await assignAccountPlan(integration.app, account, PREDEFINED_PLAN_IDS.pro);
    await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);

    const retry = await consume(account, { userId: user.id, units: 15, requestId: "sw" });

    expect(retry.body).toBe(first.body);
    expect(retry.json<DecisionBody>()).toMatchObject({
      account: { planName: "Starter" },
      user: { planName: "Basic" },
    });
  });

  it("uses the new plan for new requests after a switch, keeping the month's usage", async () => {
    const { account, user } = await freshTenant("New Plan Applies");
    await consumeOk(account, user.id, 20);
    await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);

    const decision = await consumeOk(account, user.id, 50);

    expect(decision).toMatchObject({
      accepted: true,
      user: { planName: "Premium", maxUnitsPerRequest: 100, used: 70, remaining: 9_930 },
    });
  });
});

describe("UTC months", () => {
  it("replays the original decision after the month changes, and counts new requests from zero", async () => {
    const { account, user } = await freshTenant("Month Rollover");
    now = new Date("2026-10-31T23:59:59.999Z");
    const october = await consume(account, { userId: user.id, units: 20, requestId: "oct" });

    now = new Date("2026-11-01T00:00:00.000Z");
    const replay = await consume(account, { userId: user.id, units: 20, requestId: "oct" });
    const november = await consumeOk(account, user.id, 20, "nov");

    expect(october.json<DecisionBody>()).toMatchObject({
      month: "2026-10",
      processedAt: "2026-10-31T23:59:59.999Z",
    });
    expect(replay.body).toBe(october.body);
    expect(november).toMatchObject({
      month: "2026-11",
      accepted: true,
      account: { used: 20 },
      user: { used: 20, remaining: 980 },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 20, user: 20 });
    expect(await readCounters(account.id, user.id, "2026-11-01")).toEqual({
      account: 20,
      user: 20,
    });
  });

  it("starts a new year in a new month", async () => {
    const { account, user } = await freshTenant("Year Rollover");
    now = new Date("2026-12-31T23:59:59.999Z");
    const december = await consumeOk(account, user.id, 1);
    now = new Date("2027-01-01T00:00:00.000Z");
    const january = await consumeOk(account, user.id, 1);

    expect(december.month).toBe("2026-12");
    expect(january).toMatchObject({ month: "2027-01", user: { used: 1 } });
  });
});
