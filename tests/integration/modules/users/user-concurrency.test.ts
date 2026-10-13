import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

const BASIC_PLAN_ID = "b0000000-0000-4000-8000-000000000001";
const PREMIUM_PLAN_ID = "b0000000-0000-4000-8000-000000000002";

interface User {
  id: string;
  updatedAt: string;
  plan: { id: string };
}

/** Every clock read is one second later, so each request gets its own distinct timestamp. */
let clockReads = 0;
const clockStart = new Date("2026-10-13T12:00:00.000Z").getTime();
let integration: IntegrationApp;
let accountA: TestAccount;
let accountB: TestAccount;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({
    clock: () => {
      clockReads += 1;
      return new Date(clockStart + clockReads * 1_000);
    },
  });
  accountA = await createTestAccount(integration.app, "Concurrent A");
  accountB = await createTestAccount(integration.app, "Concurrent B");
});

afterAll(async () => {
  await integration.close();
});

function postUser(account: TestAccount, name: string) {
  return authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/users",
    payload: { name },
  });
}

async function listUserIds(account: TestAccount): Promise<string[]> {
  const response = await authenticatedRequest(integration.app, account, {
    method: "GET",
    url: "/v1/users",
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ users: User[] }>().users.map((user) => user.id);
}

describe("concurrent user creation", () => {
  it("creates every user exactly once, on Basic, in the right account", async () => {
    const requests = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? postUser(accountA, `A ${String(index)}`)
        : postUser(accountB, `B ${String(index)}`),
    );

    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.statusCode)).toEqual(Array(20).fill(201));
    const created = responses.map((response) => response.json<User>());
    expect(new Set(created.map((user) => user.id)).size).toBe(20);
    expect(created.every((user) => user.plan.id === BASIC_PLAN_ID)).toBe(true);
    const createdIn = (owner: TestAccount) =>
      created
        .filter((_, index) => (index % 2 === 0 ? accountA : accountB) === owner)
        .map((user) => user.id)
        .sort();
    expect([...(await listUserIds(accountA))].sort()).toEqual(createdIn(accountA));
    expect([...(await listUserIds(accountB))].sort()).toEqual(createdIn(accountB));
  });
});

describe("concurrent plan switching", () => {
  it("changes the plan once when the same switch races: one updatedAt, never overwritten", async () => {
    const created = await postUser(accountA, "Racer");
    expect(created.statusCode).toBe(201);
    const user = created.json<User>();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        authenticatedRequest(integration.app, accountA, {
          method: "PUT",
          url: `/v1/users/${user.id}/plan`,
          payload: { planId: PREMIUM_PLAN_ID },
        }),
      ),
    );

    // Each request read a different clock value, but only the one that changed the plan may
    // write it: every later request sees the committed change and keeps that updatedAt.
    expect(responses.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
    const bodies = responses.map((response) => response.json<User>());
    expect(new Set(bodies.map((body) => body.updatedAt)).size).toBe(1);
    expect(bodies[0]?.plan.id).toBe(PREMIUM_PLAN_ID);
    const stored = await withTestClient(async (client) => {
      const result = await client.query<{ plan_id: string; updated_at: Date }>(
        "SELECT plan_id, updated_at FROM users WHERE id = $1",
        [user.id],
      );
      return result.rows[0];
    });
    expect(stored?.plan_id).toBe(PREMIUM_PLAN_ID);
    expect(stored?.updated_at.toISOString()).toBe(bodies[0]?.updatedAt);
  });
});
