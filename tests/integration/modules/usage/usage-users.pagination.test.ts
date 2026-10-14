import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeCursor } from "../../../../src/shared/cursor.js";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  assignUserPlan,
  createTestUser,
  PREDEFINED_PLAN_IDS,
} from "../../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";

/** GET /v1/usage/users: newest user first on users.seq, month and form fixed per traversal. */

const INVALID_CURSOR = '{"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}';

interface ListedUser {
  userId: string;
  name: string;
  used: number;
  planName?: string;
  remaining?: number;
}

interface Page {
  month: string;
  currentMonth: boolean;
  users: ListedUser[];
  nextCursor: string | null;
}

let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let account: TestAccount;
/** Users of `account` in creation order (oldest first). */
let userIds: string[];
let other: TestAccount;
let otherUserId: string;
let requestSequence = 0;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
  account = await createTestAccount(integration.app, "Usage List");
  userIds = [];
  for (let index = 0; index < 25; index += 1) {
    userIds.push((await createTestUser(integration.app, account, `Member ${String(index)}`)).id);
  }
  other = await createTestAccount(integration.app, "Other");
  otherUserId = (await createTestUser(integration.app, other, "Elsewhere")).id;
  // Usage in September (now a past month) and October (current).
  now = new Date("2026-09-20T12:00:00.000Z");
  await consume(account, userIds[0] ?? "", 9);
  now = new Date("2026-10-13T12:00:00.000Z");
  await consume(account, userIds[0] ?? "", 20);
  await consume(account, userIds[24] ?? "", 3);
  await consume(other, otherUserId, 5);
});

afterAll(async () => {
  await integration.close();
});

async function consume(owner: TestAccount, userId: string, units: number) {
  requestSequence += 1;
  const response = await authenticatedRequest(integration.app, owner, {
    method: "POST",
    url: "/v1/consume",
    payload: { userId, units, requestId: `uu-${String(requestSequence)}` },
  });
  expect(response.statusCode, response.body).toBe(200);
}

function list(caller: TestAccount, query = "") {
  return authenticatedRequest(integration.app, caller, {
    method: "GET",
    url: `/v1/usage/users${query}`,
  });
}

async function listOk(caller: TestAccount, query = ""): Promise<Page> {
  const response = await list(caller, query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

async function walk(caller: TestAccount, firstQuery: string): Promise<Page[]> {
  const pages = [await listOk(caller, firstQuery)];
  let cursor = pages[0]?.nextCursor ?? null;
  while (cursor !== null && pages.length < 50) {
    const page = await listOk(caller, `?cursor=${cursor}`);
    pages.push(page);
    cursor = page.nextCursor;
  }
  return pages;
}

const newestFirst = () => [...userIds].reverse();

describe("current month", () => {
  it("lists every user newest first, 20 per page, with live plan, usage and remaining", async () => {
    const pages = await walk(account, "");

    expect(pages.map((page) => page.users.length)).toEqual([20, 5]);
    expect(pages.every((page) => page.month === "2026-10" && page.currentMonth)).toBe(true);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const listed = pages.flatMap((page) => page.users);
    expect(listed.map((user) => user.userId)).toEqual(newestFirst());
    expect(listed[0]).toEqual({
      userId: userIds[24],
      name: "Member 24",
      planId: PREDEFINED_PLAN_IDS.basic,
      planName: "Basic",
      used: 3,
      monthlyAllowance: 1_000,
      maxUnitsPerRequest: 20,
      remaining: 997,
    });
    expect(listed.at(-1)).toMatchObject({ userId: userIds[0], used: 20, remaining: 980 });
    // Users without a counter row are listed with zero usage.
    expect(listed[1]).toMatchObject({ used: 0, remaining: 1_000 });
  });

  it("reflects each user's current plan", async () => {
    const user = await createTestUser(integration.app, account, "Premium Member");
    await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);

    const first = await listOk(account, "?limit=1");

    expect(first.users[0]).toMatchObject({
      userId: user.id,
      planName: "Premium",
      monthlyAllowance: 10_000,
    });
    userIds.push(user.id);
  });
});

describe("past months", () => {
  it("reports used only, with currentMonth false, for every user", async () => {
    const pages = await walk(account, "?month=2026-09&limit=10");

    expect(pages.every((page) => page.month === "2026-09" && !page.currentMonth)).toBe(true);
    const listed = pages.flatMap((page) => page.users);
    expect(listed.map((user) => user.userId)).toEqual(newestFirst());
    for (const user of listed) {
      expect(Object.keys(user).sort()).toEqual(["name", "used", "userId"]);
    }
    expect(listed.at(-1)).toEqual({ userId: userIds[0], name: "Member 0", used: 9 });
  });
});

describe("self-contained continuation", () => {
  it("keeps the cursor's month when the continuation omits it, and accepts it repeated", async () => {
    const first = await listOk(account, "?month=2026-09&limit=5");

    const omitted = await listOk(account, `?cursor=${String(first.nextCursor)}`);
    const repeated = await listOk(account, `?cursor=${String(first.nextCursor)}&month=2026-09`);

    expect(omitted).toEqual(repeated);
    expect(omitted).toMatchObject({ month: "2026-09", currentMonth: false });
    expect(omitted.users.map((user) => user.userId)).toEqual(newestFirst().slice(5, 25));
  });

  it("rejects a continuation that changes the month", async () => {
    const first = await listOk(account, "?month=2026-09&limit=5");

    const response = await list(account, `?cursor=${String(first.nextCursor)}&month=2026-10`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(INVALID_CURSOR);
  });

  it("allows the page size to change between pages", async () => {
    const first = await listOk(account, "?limit=2");
    const second = await listOk(account, `?cursor=${String(first.nextCursor)}&limit=100`);

    expect([...first.users, ...second.users].map((user) => user.userId)).toEqual(newestFirst());
    expect(second.nextCursor).toBeNull();
  });
});

describe("UTC month rollover", () => {
  it("expires a current-month traversal when the month changes; a restart for that month is past-form", async () => {
    now = new Date("2026-10-31T23:59:59.999Z");
    const first = await listOk(account, "?limit=5");
    expect(first).toMatchObject({ month: "2026-10", currentMonth: true });
    expect(first.users[0]).toHaveProperty("remaining");

    now = new Date("2026-11-01T00:00:00.000Z");
    const expired = await list(account, `?cursor=${String(first.nextCursor)}`);
    const restarted = await listOk(account, "?month=2026-10&limit=5");

    expect(expired.statusCode).toBe(400);
    expect(expired.body).toBe(INVALID_CURSOR);
    expect(restarted).toMatchObject({ month: "2026-10", currentMonth: false });
    expect(restarted.users[0]).not.toHaveProperty("remaining");
    now = new Date("2026-10-13T12:00:00.000Z");
  });

  it("keeps a past-month traversal valid across the change of month", async () => {
    now = new Date("2026-10-31T23:59:59.999Z");
    const first = await listOk(account, "?month=2026-09&limit=5");

    now = new Date("2026-11-01T00:00:00.000Z");
    const second = await listOk(account, `?cursor=${String(first.nextCursor)}&limit=5`);

    expect(second).toMatchObject({ month: "2026-09", currentMonth: false });
    expect(second.users.map((user) => user.userId)).toEqual(newestFirst().slice(5, 10));
    now = new Date("2026-10-13T12:00:00.000Z");
  });
});

describe("cursor and parameter validation", () => {
  const anchor = () => userIds[10] ?? "";

  it.each([
    ["random text", () => "not-a-cursor"],
    ["a users cursor", () => encodeCursor({ kind: "users", anchor: anchor() })],
    [
      "a history cursor",
      () => encodeCursor({ kind: "history", anchor: anchor(), userId: null, month: null }),
    ],
    [
      "an unknown anchor",
      () =>
        encodeCursor({
          kind: "usage-users",
          anchor: "00000000-0000-4000-8000-000000000000",
          month: "2026-10",
          currentMonth: true,
        }),
    ],
    [
      "another account's user as anchor",
      () =>
        encodeCursor({
          kind: "usage-users",
          anchor: otherUserId,
          month: "2026-10",
          currentMonth: true,
        }),
    ],
    [
      "a current-month flag on a past month",
      () =>
        encodeCursor({
          kind: "usage-users",
          anchor: anchor(),
          month: "2026-09",
          currentMonth: true,
        }),
    ],
    [
      "a past-month flag on the current month",
      () =>
        encodeCursor({
          kind: "usage-users",
          anchor: anchor(),
          month: "2026-10",
          currentMonth: false,
        }),
    ],
    [
      "a future month",
      () =>
        encodeCursor({
          kind: "usage-users",
          anchor: anchor(),
          month: "2026-12",
          currentMonth: false,
        }),
    ],
  ])("answers %s with the one Invalid cursor response", async (_label, cursor) => {
    const response = await list(account, `?cursor=${encodeURIComponent(cursor())}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(INVALID_CURSOR);
  });

  it("lets a caller start below one of its own users with a constructed cursor", async () => {
    const cursor = encodeCursor({
      kind: "usage-users",
      anchor: userIds[3] ?? "",
      month: "2026-10",
      currentMonth: true,
    });

    const page = await listOk(account, `?cursor=${cursor}`);

    expect(page.users.map((user) => user.userId)).toEqual([userIds[2], userIds[1], userIds[0]]);
  });

  it.each([
    ["a future month", "?month=2026-11"],
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["an exponent limit", "?limit=1e1"],
    ["a repeated month", "?month=2026-09&month=2026-09"],
    ["an unknown parameter", "?userId=x"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, query) => {
    const response = await list(account, query);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("isolation and query counts", () => {
  it("never lists another account's users or usage", async () => {
    const pages = await walk(other, "");

    expect(pages.flatMap((page) => page.users.map((user) => user.userId))).toEqual([otherUserId]);
    expect(pages[0]?.users[0]).toMatchObject({ used: 5 });
    const own = (await walk(account, "?limit=100")).flatMap((page) => page.users);
    expect(own.map((user) => user.userId)).not.toContain(otherUserId);
  });

  it("uses two queries for a first page and three for a continuation, whatever the page size", async () => {
    const query = vi.spyOn(integration.pool, "query");
    try {
      const big = await listOk(account, "?limit=100");
      const firstCount = query.mock.calls.length;
      query.mockClear();
      const small = await listOk(account, "?limit=1");
      const smallCount = query.mock.calls.length;
      query.mockClear();
      await listOk(account, `?cursor=${String(small.nextCursor)}&limit=100`);
      const continuationCount = query.mock.calls.length;

      expect(big.users.length).toBe(userIds.length);
      expect([firstCount, smallCount, continuationCount]).toEqual([2, 2, 3]);
    } finally {
      query.mockRestore();
    }
  });
});
