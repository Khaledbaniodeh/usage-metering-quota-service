import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  assignUserPlan,
  countCounterRows,
  countDecisions,
  createTestPlan,
  createTestUser,
  PREDEFINED_PLAN_IDS,
} from "../../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";

/** GET /v1/usage and GET /v1/users/{userId}/usage on real PostgreSQL with a controlled clock. */

const UNKNOWN_USER_ID = "00000000-0000-4000-8000-000000000000";

let now = new Date("2026-10-13T12:00:00.000Z");
let clockReads = 0;
let integration: IntegrationApp;
let requestSequence = 0;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({
    clock: () => {
      clockReads += 1;
      return now;
    },
  });
});

afterAll(async () => {
  await integration.close();
});

function get(account: TestAccount, url: string) {
  return authenticatedRequest(integration.app, account, { method: "GET", url });
}

async function getOk(account: TestAccount, url: string): Promise<unknown> {
  const response = await get(account, url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function consume(account: TestAccount, userId: string, units: number) {
  requestSequence += 1;
  const response = await authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/consume",
    payload: { userId, units, requestId: `u-${String(requestSequence)}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ accepted: boolean }>();
}

describe("authentication", () => {
  it.each(["/v1/usage", `/v1/users/${UNKNOWN_USER_ID}/usage`, "/v1/usage/users"])(
    "%s requires an API key",
    async (url) => {
      const response = await integration.app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(401);
    },
  );

  // R08: "Reject missing or invalid keys", here for the paginated per-user usage list.
  it("answers GET /v1/usage/users without a valid key with the standard 401, no data and no writes", async () => {
    const owner = await createTestAccount(integration.app, "Listed Owner");
    const user = await createTestUser(integration.app, owner, "Listed User");
    await consume(owner, user.id, 5);
    const before = [await countDecisions(owner.id), await countCounterRows(owner.id)];
    const url = "/v1/usage/users?month=2026-10&limit=1";

    const missing = await integration.app.inject({ method: "GET", url });
    const invalid = await integration.app.inject({
      method: "GET",
      url,
      headers: { "x-api-key": `umqs_${"A".repeat(43)}` },
    });
    const malformed = await integration.app.inject({
      method: "GET",
      url,
      headers: { "x-api-key": "not-a-key" },
    });

    for (const response of [missing, invalid, malformed]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "A valid API key is required" },
      });
      expect(response.body).not.toContain(user.id);
      expect(response.body).not.toContain(owner.id);
    }
    expect(invalid.body).toBe(missing.body);
    expect(malformed.body).toBe(missing.body);
    expect([await countDecisions(owner.id), await countCounterRows(owner.id)]).toEqual(before);
    // The owner's own key still lists the user.
    expect(await getOk(owner, url)).toMatchObject({ users: [{ userId: user.id, used: 5 }] });
  });
});

describe("current month", () => {
  it("reports zero usage with the live plan limits when nothing was consumed", async () => {
    const account = await createTestAccount(integration.app, "Fresh");
    const user = await createTestUser(integration.app, account);

    expect(await getOk(account, "/v1/usage")).toEqual({
      month: "2026-10",
      used: 0,
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 100,
      remaining: 10_000,
    });
    expect(await getOk(account, `/v1/users/${user.id}/usage`)).toEqual({
      month: "2026-10",
      used: 0,
      monthlyAllowance: 1_000,
      maxUnitsPerRequest: 20,
      remaining: 1_000,
    });
  });

  it("counts accepted units only, and the account total is the sum of its users", async () => {
    const account = await createTestAccount(integration.app, "Totals");
    const ada = await createTestUser(integration.app, account, "Ada");
    const bob = await createTestUser(integration.app, account, "Bob");
    expect((await consume(account, ada.id, 20)).accepted).toBe(true);
    expect((await consume(account, ada.id, 5)).accepted).toBe(true);
    expect((await consume(account, bob.id, 7)).accepted).toBe(true);
    expect((await consume(account, bob.id, 25)).accepted).toBe(false);

    expect(await getOk(account, `/v1/users/${ada.id}/usage`)).toMatchObject({
      used: 25,
      remaining: 975,
    });
    expect(await getOk(account, `/v1/users/${bob.id}/usage`)).toMatchObject({
      used: 7,
      remaining: 993,
    });
    expect(await getOk(account, "/v1/usage")).toMatchObject({ used: 32, remaining: 9_968 });
  });

  it("returns the same current form when the current month is named explicitly", async () => {
    const account = await createTestAccount(integration.app, "Explicit");

    expect(await getOk(account, "/v1/usage?month=2026-10")).toEqual(
      await getOk(account, "/v1/usage"),
    );
  });

  it("shows the newly assigned plan's limits with the month's usage kept", async () => {
    const account = await createTestAccount(integration.app, "Switch");
    const user = await createTestUser(integration.app, account);
    await consume(account, user.id, 20);
    await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);

    expect(await getOk(account, `/v1/users/${user.id}/usage`)).toEqual({
      month: "2026-10",
      used: 20,
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 100,
      remaining: 9_980,
    });
  });

  it("shows zero remaining when the allowance was reduced below usage", async () => {
    const account = await createTestAccount(integration.app, "Reduced");
    const user = await createTestUser(integration.app, account);
    const plan = await createTestPlan(integration.app, account, {
      name: "Shrinking",
      scope: "USER",
      monthlyAllowance: 100,
      maxUnitsPerRequest: 20,
    });
    await assignUserPlan(integration.app, account, user.id, plan);
    await consume(account, user.id, 20);
    await consume(account, user.id, 20);
    const patch = await authenticatedRequest(integration.app, account, {
      method: "PATCH",
      url: `/v1/plans/${plan}`,
      payload: { monthlyAllowance: 30 },
    });
    expect(patch.statusCode).toBe(200);

    expect(await getOk(account, `/v1/users/${user.id}/usage`)).toMatchObject({
      used: 40,
      monthlyAllowance: 30,
      remaining: 0,
    });
  });

  it("reads the clock once per request and uses two queries", async () => {
    const account = await createTestAccount(integration.app, "Counted");
    const user = await createTestUser(integration.app, account);
    const query = vi.spyOn(integration.pool, "query");
    try {
      clockReads = 0;
      query.mockClear();
      await getOk(account, "/v1/usage");
      expect([clockReads, query.mock.calls.length]).toEqual([1, 2]);

      clockReads = 0;
      query.mockClear();
      await getOk(account, `/v1/users/${user.id}/usage?month=2026-09`);
      expect([clockReads, query.mock.calls.length]).toEqual([1, 2]);
    } finally {
      query.mockRestore();
    }
  });
});

describe("past months and UTC boundaries", () => {
  it("reports used only for a past month, and zero for a past month without usage", async () => {
    const account = await createTestAccount(integration.app, "History Months");
    const user = await createTestUser(integration.app, account);
    now = new Date("2026-10-31T23:59:59.999Z");
    await consume(account, user.id, 15);
    now = new Date("2026-11-01T00:00:00.000Z");

    expect(await getOk(account, "/v1/usage")).toEqual({
      month: "2026-11",
      used: 0,
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 100,
      remaining: 10_000,
    });
    expect(await getOk(account, "/v1/usage?month=2026-10")).toEqual({
      month: "2026-10",
      used: 15,
    });
    expect(await getOk(account, `/v1/users/${user.id}/usage?month=2026-10`)).toEqual({
      month: "2026-10",
      used: 15,
    });
    expect(await getOk(account, "/v1/usage?month=2026-09")).toEqual({
      month: "2026-09",
      used: 0,
    });
  });

  it("moves to a new year at the January boundary", async () => {
    const account = await createTestAccount(integration.app, "New Year");
    const user = await createTestUser(integration.app, account);
    now = new Date("2026-12-31T23:59:59.999Z");
    await consume(account, user.id, 3);
    now = new Date("2027-01-01T00:00:00.000Z");
    await consume(account, user.id, 4);

    expect(await getOk(account, "/v1/usage?month=2026-12")).toEqual({
      month: "2026-12",
      used: 3,
    });
    expect(await getOk(account, `/v1/users/${user.id}/usage`)).toMatchObject({
      month: "2027-01",
      used: 4,
    });
  });
});

describe("validation and isolation", () => {
  it.each([
    ["a future month", "?month=2099-01"],
    ["the next month", "?month=NEXT"],
    ["a month without a leading zero", "?month=2026-1"],
    ["month 13", "?month=2026-13"],
    ["a date", "?month=2026-10-01"],
    ["a year below 1000", "?month=0999-01"],
    ["an empty month", "?month="],
    ["a repeated month", "?month=2026-10&month=2026-10"],
    ["an unknown parameter", "?accountId=x"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, query) => {
    const account = await createTestAccount(integration.app, "Validation");
    const user = await createTestUser(integration.app, account);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const resolved = query.replace(
      "NEXT",
      `${String(next.getUTCFullYear())}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`,
    );

    for (const url of [`/v1/usage${resolved}`, `/v1/users/${user.id}/usage${resolved}`]) {
      const response = await get(account, url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects a malformed user ID with 400", async () => {
    const account = await createTestAccount(integration.app, "Bad ID");

    const response = await get(account, "/v1/users/not-a-uuid/usage");

    expect(response.statusCode).toBe(400);
  });

  it("answers another account's user exactly like an unknown user", async () => {
    const caller = await createTestAccount(integration.app, "Caller");
    const owner = await createTestAccount(integration.app, "Owner");
    const ownersUser = await createTestUser(integration.app, owner, "Private");
    await consume(owner, ownersUser.id, 9);

    const foreign = await get(caller, `/v1/users/${ownersUser.id}/usage`);
    const unknown = await get(caller, `/v1/users/${UNKNOWN_USER_ID}/usage`);

    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    expect(foreign.json()).toEqual({ error: { code: "NOT_FOUND", message: "User not found" } });
  });

  it("checks a future month before the user", async () => {
    const account = await createTestAccount(integration.app, "Order");

    const response = await get(account, `/v1/users/${UNKNOWN_USER_ID}/usage?month=2099-01`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "month must not be in the future" },
    });
  });

  it("never shows another account's usage in the account summary", async () => {
    const quiet = await createTestAccount(integration.app, "Quiet");
    const busy = await createTestAccount(integration.app, "Busy");
    const busyUser = await createTestUser(integration.app, busy);
    await consume(busy, busyUser.id, 20);

    expect(await getOk(quiet, "/v1/usage")).toMatchObject({ used: 0 });
  });
});
