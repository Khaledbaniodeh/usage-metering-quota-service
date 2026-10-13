import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

const BASIC_PLAN = {
  id: "b0000000-0000-4000-8000-000000000001",
  code: "basic",
  name: "Basic",
  scope: "USER",
  monthlyAllowance: 1_000,
  maxUnitsPerRequest: 20,
};
const UNKNOWN_USER_ID = "00000000-0000-4000-8000-000000000000";

interface User {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  plan: typeof BASIC_PLAN;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let accountA: TestAccount;
let accountB: TestAccount;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
  accountA = await createTestAccount(integration.app, "Users A");
  accountB = await createTestAccount(integration.app, "Users B");
});

afterAll(async () => {
  await integration.close();
});

function postUser(account: TestAccount, payload: unknown) {
  return authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/users",
    payload: payload as object,
  });
}

function getUsers(account: TestAccount, query = "") {
  return authenticatedRequest(integration.app, account, {
    method: "GET",
    url: `/v1/users${query}`,
  });
}

function getUser(account: TestAccount, userId: string) {
  return authenticatedRequest(integration.app, account, {
    method: "GET",
    url: `/v1/users/${userId}`,
  });
}

async function createUser(account: TestAccount, name = "Test User"): Promise<User> {
  const response = await postUser(account, { name });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<User>();
}

async function storedUser(userId: string) {
  return withTestClient(async (client) => {
    const result = await client.query<{ account_id: string; plan_id: string; name: string }>(
      "SELECT account_id, plan_id, name FROM users WHERE id = $1",
      [userId],
    );
    return result.rows[0];
  });
}

async function userCount(): Promise<number> {
  return withTestClient(async (client) => {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users",
    );
    return result.rows[0]?.count ?? -1;
  });
}

describe("user endpoints require authentication", () => {
  it.each([
    ["POST", "/v1/users"],
    ["GET", "/v1/users"],
    ["GET", `/v1/users/${UNKNOWN_USER_ID}`],
  ] as const)("%s %s without X-API-Key returns 401", async (method, url) => {
    const before = await userCount();

    const response = await integration.app.inject({ method, url, payload: { name: "Nobody" } });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
    expect(await userCount()).toBe(before);
  });
});

describe("POST /v1/users", () => {
  it("creates a user of the authenticated account on the predefined Basic plan", async () => {
    const response = await postUser(accountA, { name: "Ada" });

    expect(response.statusCode).toBe(201);
    const user = response.json<User>();
    expect(user).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as unknown,
      name: "Ada",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      plan: BASIC_PLAN,
    });
    expect(await storedUser(user.id)).toEqual({
      account_id: accountA.id,
      plan_id: BASIC_PLAN.id,
      name: "Ada",
    });
  });

  it("allows duplicate names within an account", async () => {
    const first = await createUser(accountA, "Twin");
    const second = await createUser(accountA, "Twin");

    expect(second.id).not.toBe(first.id);
  });

  it("accepts a Unicode name", async () => {
    const user = await createUser(accountA, "Zoë 李 🚀");

    expect(user.name).toBe("Zoë 李 🚀");
  });

  it.each([
    ["an account ID", { accountId: "a1111111-1111-4111-8111-111111111111" }],
    ["a plan ID", { planId: "b0000000-0000-4000-8000-000000000002" }],
    ["an ID", { id: UNKNOWN_USER_ID }],
  ])("rejects a body that tries to set %s, creating nothing", async (_label, extra) => {
    const before = await userCount();

    const response = await postUser(accountA, { name: "Hijack", ...extra });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    expect(await userCount()).toBe(before);
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { name: "" }],
    ["a name of 101 characters", { name: "x".repeat(101) }],
    ["a name with leading whitespace", { name: " Ada" }],
    ["a name with trailing whitespace", { name: "Ada " }],
    ["a name with a newline", { name: "Ada\nLovelace" }],
    ["a name with a NUL character", { name: "Ada\u0000" }],
    ["a numeric name", { name: 42 }],
    ["a null name", { name: null }],
    ["an array body", ["Ada"]],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, payload) => {
    const before = await userCount();

    const response = await postUser(accountA, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    expect(await userCount()).toBe(before);
  });

  it("accepts a name of exactly 100 characters", async () => {
    const name = "y".repeat(100);

    expect((await createUser(accountA, name)).name).toBe(name);
  });
});

describe("GET /v1/users/:userId", () => {
  it("returns the account's own user with its plan", async () => {
    const created = await createUser(accountA, "Lookup");

    const response = await getUser(accountA, created.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(created);
  });

  it("answers another account's user exactly like an unknown user", async () => {
    const foreign = await createUser(accountB, "Private");

    const foreignResponse = await getUser(accountA, foreign.id);
    const unknownResponse = await getUser(accountA, UNKNOWN_USER_ID);

    expect(foreignResponse.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    expect(foreignResponse.json()).toEqual({
      error: { code: "NOT_FOUND", message: "User not found" },
    });
    expect(unknownResponse.body).toBe(foreignResponse.body);
    expect(foreignResponse.body).not.toContain("Private");
  });

  it.each(["not-a-uuid", "123", `${UNKNOWN_USER_ID}0`])(
    "rejects the malformed user ID %s with 400",
    async (userId) => {
      const response = await getUser(accountA, userId);

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    },
  );
});

describe("GET /v1/users", () => {
  it("returns an empty list for an account without users", async () => {
    const fresh = await createTestAccount(integration.app, "No Users");

    const response = await getUsers(fresh);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ users: [], nextCursor: null });
  });

  it("lists only the account's own users, oldest first", async () => {
    const owner = await createTestAccount(integration.app, "Listing Owner");
    const other = await createTestAccount(integration.app, "Listing Other");
    const first = await createUser(owner, "First");
    await createUser(other, "Someone Else");
    now = new Date(now.getTime() + 1_000);
    const second = await createUser(owner, "Second");

    const response = await getUsers(owner);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ users: [first, second], nextCursor: null });
    expect(response.body).not.toContain("Someone Else");
  });

  it("rejects query parameters with 400", async () => {
    const response = await getUsers(accountA, `?accountId=${accountB.id}`);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
  });

  it("uses the same number of queries whatever the number of users (no N+1)", async () => {
    const small = await createTestAccount(integration.app, "One User");
    const large = await createTestAccount(integration.app, "Five Users");
    await createUser(small);
    for (let index = 0; index < 5; index += 1) {
      await createUser(large);
    }
    const query = vi.spyOn(integration.pool, "query");

    try {
      const smallResponse = await getUsers(small);
      const smallQueries = query.mock.calls.length;
      query.mockClear();
      const largeResponse = await getUsers(large);
      const largeQueries = query.mock.calls.length;

      expect(smallResponse.json<{ users: User[] }>().users).toHaveLength(1);
      expect(largeResponse.json<{ users: User[] }>().users).toHaveLength(5);
      // One query authenticates the key and one lists the users with their plans.
      expect(smallQueries).toBe(2);
      expect(largeQueries).toBe(2);
    } finally {
      query.mockRestore();
    }
  });
});
