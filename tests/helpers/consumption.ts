import { expect } from "vitest";
import type { App } from "../../src/app/build-app.js";
import { authenticatedRequest, type TestAccount } from "./account-harness.js";
import { withTestClient } from "./test-database.js";

/** Helpers for consumption tests: fixtures through the real API, state read directly via SQL. */

export const PREDEFINED_PLAN_IDS = {
  starter: "a0000000-0000-4000-8000-000000000001",
  pro: "a0000000-0000-4000-8000-000000000002",
  basic: "b0000000-0000-4000-8000-000000000001",
  premium: "b0000000-0000-4000-8000-000000000002",
} as const;

export interface TestUser {
  readonly id: string;
}

export async function createTestUser(
  app: App,
  account: TestAccount,
  name = "User",
): Promise<TestUser> {
  const response = await authenticatedRequest(app, account, {
    method: "POST",
    url: "/v1/users",
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return { id: response.json<TestUser>().id };
}

export async function createTestPlan(
  app: App,
  account: TestAccount,
  plan: {
    name: string;
    scope: "ACCOUNT" | "USER";
    monthlyAllowance: number;
    maxUnitsPerRequest: number;
  },
): Promise<string> {
  const response = await authenticatedRequest(app, account, {
    method: "POST",
    url: "/v1/plans",
    payload: plan,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

export async function assignAccountPlan(
  app: App,
  account: TestAccount,
  planId: string,
): Promise<void> {
  const response = await authenticatedRequest(app, account, {
    method: "PUT",
    url: "/v1/account/plan",
    payload: { planId },
  });
  expect(response.statusCode, response.body).toBe(200);
}

export async function assignUserPlan(
  app: App,
  account: TestAccount,
  userId: string,
  planId: string,
): Promise<void> {
  const response = await authenticatedRequest(app, account, {
    method: "PUT",
    url: `/v1/users/${userId}/plan`,
    payload: { planId },
  });
  expect(response.statusCode, response.body).toBe(200);
}

export interface Counters {
  /** Undefined when the counter row does not exist. */
  readonly account: number | undefined;
  readonly user: number | undefined;
}

/** The stored account and user counters for one month (`YYYY-MM-01`). */
export async function readCounters(
  accountId: string,
  userId: string,
  month: string,
): Promise<Counters> {
  return withTestClient(async (client) => {
    const account = await client.query<{ used: number }>(
      "SELECT used FROM account_monthly_usage WHERE account_id = $1 AND month = $2",
      [accountId, month],
    );
    const user = await client.query<{ used: number }>(
      "SELECT used FROM user_monthly_usage WHERE user_id = $1 AND month = $2",
      [userId, month],
    );
    return { account: account.rows[0]?.used, user: user.rows[0]?.used };
  });
}

/** Number of decision rows (optionally for one request ID) of an account. */
export async function countDecisions(accountId: string, requestId?: string): Promise<number> {
  return withTestClient(async (client) => {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM consume_decisions
       WHERE account_id = $1 AND ($2::text IS NULL OR request_id = $2)`,
      [accountId, requestId ?? null],
    );
    return result.rows[0]?.count ?? -1;
  });
}

/** Number of counter rows (account and user) that belong to an account. */
export async function countCounterRows(accountId: string): Promise<number> {
  return withTestClient(async (client) => {
    const result = await client.query<{ count: number }>(
      `SELECT (SELECT count(*) FROM account_monthly_usage WHERE account_id = $1)::int
            + (SELECT count(*) FROM user_monthly_usage WHERE account_id = $1)::int AS count`,
      [accountId],
    );
    return result.rows[0]?.count ?? -1;
  });
}
