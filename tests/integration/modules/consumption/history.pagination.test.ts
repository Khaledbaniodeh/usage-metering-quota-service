import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeCursor } from "../../../../src/shared/cursor.js";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  assignAccountPlan,
  assignUserPlan,
  createTestUser,
  PREDEFINED_PLAN_IDS,
} from "../../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

/**
 * GET /v1/history: stored decisions, newest first on consume_decisions.seq, with filter-bound,
 * self-contained cursors whose anchor must belong to the account AND the filtered set.
 */

const INVALID_CURSOR = '{"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}';
const USER_NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"User not found"}}';
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const OCTOBER_INSTANT = "2026-10-13T12:00:00.000Z";

interface Filter {
  userId?: string;
  month?: string;
}

interface Decision {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  month: string;
  processedAt: string;
}

interface Page {
  userId: string | null;
  month: string | null;
  decisions: Decision[];
  nextCursor: string | null;
}

let now = new Date("2026-09-20T12:00:00.000Z");
let clockReads = 0;
let integration: IntegrationApp;
let account: TestAccount;
let ada: string;
let bob: string;
let other: TestAccount;
let otherUser: string;
let otherDecisionId: string;
/** The original POST /v1/consume response body of every decision of `account`, by requestId. */
const originalBodies = new Map<string, string>();
let requestSequence = 0;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({
    clock: () => {
      clockReads += 1;
      return now;
    },
  });
  account = await createTestAccount(integration.app, "History");
  ada = (await createTestUser(integration.app, account, "Ada")).id;
  bob = (await createTestUser(integration.app, account, "Bob")).id;
  other = await createTestAccount(integration.app, "Other");
  otherUser = (await createTestUser(integration.app, other, "Elsewhere")).id;

  // September: 3 for Ada, 2 for Bob.
  for (const userId of [ada, bob, ada, bob, ada]) {
    await consume(account, userId, 2);
  }
  // October: 30 decisions, all at the same instant, including rejections (25 > 20 per request).
  now = new Date(OCTOBER_INSTANT);
  for (let index = 0; index < 30; index += 1) {
    await consume(account, index % 3 === 0 ? bob : ada, index % 5 === 0 ? 25 : 1);
  }
  await consume(other, otherUser, 1);
  otherDecisionId = (await storedIds(other.id))[0] ?? "";
});

afterAll(async () => {
  await integration.close();
});

async function consume(owner: TestAccount, userId: string, units: number) {
  requestSequence += 1;
  const requestId = `h-${String(requestSequence)}`;
  const response = await authenticatedRequest(integration.app, owner, {
    method: "POST",
    url: "/v1/consume",
    payload: { userId, units, requestId },
  });
  expect(response.statusCode, response.body).toBe(200);
  if (owner === account) {
    originalBodies.set(requestId, response.body);
  }
}

/** Decision UUIDs of an account (optionally filtered), newest first by seq, read directly. */
async function storedIds(accountId: string, filter: Filter = {}): Promise<string[]> {
  return withTestClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM consume_decisions
       WHERE account_id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND ($3::date IS NULL OR month = $3)
       ORDER BY seq DESC`,
      [accountId, filter.userId ?? null, filter.month === undefined ? null : `${filter.month}-01`],
    );
    return result.rows.map((row) => row.id);
  });
}

async function storedRequestIds(accountId: string, filter: Filter = {}): Promise<string[]> {
  return withTestClient(async (client) => {
    const result = await client.query<{ request_id: string }>(
      `SELECT request_id FROM consume_decisions
       WHERE account_id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND ($3::date IS NULL OR month = $3)
       ORDER BY seq DESC`,
      [accountId, filter.userId ?? null, filter.month === undefined ? null : `${filter.month}-01`],
    );
    return result.rows.map((row) => row.request_id);
  });
}

function history(caller: TestAccount, query = "") {
  return authenticatedRequest(integration.app, caller, {
    method: "GET",
    url: `/v1/history${query}`,
  });
}

async function historyOk(caller: TestAccount, query = ""): Promise<Page> {
  const response = await history(caller, query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

/** Follows nextCursor alone (no filters repeated) to the end. */
async function walk(caller: TestAccount, firstQuery: string, limit?: number): Promise<Page[]> {
  const limitParam = limit === undefined ? "" : `&limit=${String(limit)}`;
  const pages = [await historyOk(caller, firstQuery)];
  let cursor = pages[0]?.nextCursor ?? null;
  while (cursor !== null && pages.length < 100) {
    const page = await historyOk(caller, `?cursor=${cursor}${limitParam}`);
    pages.push(page);
    cursor = page.nextCursor;
  }
  return pages;
}

function cursorFor(anchor: string, userId: string | null, month: string | null): string {
  return encodeCursor({ kind: "history", anchor, userId, month });
}

describe("basics", () => {
  it("requires an API key", async () => {
    expect((await integration.app.inject({ method: "GET", url: "/v1/history" })).statusCode).toBe(
      401,
    );
  });

  it("returns an empty page for an account without decisions", async () => {
    const fresh = await createTestAccount(integration.app, "No History");

    expect(await historyOk(fresh)).toEqual({
      userId: null,
      month: null,
      decisions: [],
      nextCursor: null,
    });
  });

  it("lists every decision newest first, 20 per page, each byte-identical to its consume response", async () => {
    const pages = await walk(account, "");

    expect(pages.map((page) => page.decisions.length)).toEqual([20, 15]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const decisions = pages.flatMap((page) => page.decisions);
    expect(decisions.map((decision) => decision.requestId)).toEqual(
      await storedRequestIds(account.id),
    );
    for (const decision of decisions) {
      expect(JSON.stringify(decision)).toBe(originalBodies.get(decision.requestId));
    }
    expect(decisions.some((decision) => !decision.accepted)).toBe(true);
  });

  it("orders by the immutable sequence, not processedAt, when many decisions share one instant", async () => {
    const pages = await walk(account, "?month=2026-10&limit=7", 7);

    const decisions = pages.flatMap((page) => page.decisions);
    expect(pages.map((page) => page.decisions.length)).toEqual([7, 7, 7, 7, 2]);
    expect(new Set(decisions.map((decision) => decision.processedAt))).toEqual(
      new Set([OCTOBER_INSTANT]),
    );
    const requestIds = decisions.map((decision) => decision.requestId);
    expect(requestIds).toEqual(await storedRequestIds(account.id, { month: "2026-10" }));
    expect(new Set(requestIds).size).toBe(30);
  });

  it("keeps showing the original snapshots after the plans are switched", async () => {
    const before = (await walk(account, "?limit=100")).flatMap((page) => page.decisions);
    await assignAccountPlan(integration.app, account, PREDEFINED_PLAN_IDS.pro);
    await assignUserPlan(integration.app, account, ada, PREDEFINED_PLAN_IDS.premium);

    const after = (await walk(account, "?limit=100")).flatMap((page) => page.decisions);

    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("Premium");
  });
});

describe("filters", () => {
  it.each<[string, () => string, () => Filter, number]>([
    ["a user", () => `?userId=${ada}`, () => ({ userId: ada }), 23],
    ["a month", () => "?month=2026-09", () => ({ month: "2026-09" }), 5],
    [
      "a user and a month",
      () => `?userId=${ada}&month=2026-09`,
      () => ({ userId: ada, month: "2026-09" }),
      3,
    ],
  ])("filters by %s and echoes the filters in effect", async (_label, query, filter, total) => {
    const pages = await walk(account, `${query()}&limit=4`, 4);

    const expected = filter();
    for (const page of pages) {
      expect(page).toMatchObject({
        userId: expected.userId ?? null,
        month: expected.month ?? null,
      });
    }
    const requestIds = pages.flatMap((page) =>
      page.decisions.map((decision) => decision.requestId),
    );
    expect(requestIds).toHaveLength(total);
    expect(requestIds).toEqual(await storedRequestIds(account.id, expected));
  });

  it("accepts an upper-case user ID and echoes it in lower case", async () => {
    const page = await historyOk(account, `?userId=${ada.toUpperCase()}&limit=1`);

    expect(page.userId).toBe(ada);
    expect(page.decisions[0]?.userId).toBe(ada);
  });

  it.each([
    ["an unknown user", () => UNKNOWN_ID],
    ["another account's user", () => otherUser],
  ])("answers %s with the identical 404", async (_label, userId) => {
    const response = await history(account, `?userId=${userId()}`);

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(USER_NOT_FOUND);
  });
});

describe("self-contained continuation", () => {
  it("takes the filters from the cursor, and accepts them repeated exactly", async () => {
    const first = await historyOk(account, `?userId=${ada}&month=2026-10&limit=2`);
    const cursor = String(first.nextCursor);

    const alone = await historyOk(account, `?cursor=${cursor}&limit=2`);
    const repeated = await historyOk(
      account,
      `?cursor=${cursor}&limit=2&userId=${ada.toUpperCase()}&month=2026-10`,
    );

    expect(alone).toEqual(repeated);
    expect(alone).toMatchObject({ userId: ada, month: "2026-10" });
    expect(alone.decisions.every((decision) => decision.userId === ada)).toBe(true);
  });

  it.each([
    ["a different user", (cursor: string) => `?cursor=${cursor}&userId=${bob}`],
    ["a different month", (cursor: string) => `?cursor=${cursor}&month=2026-09`],
  ])("rejects a continuation with %s", async (_label, query) => {
    const first = await historyOk(account, `?userId=${ada}&month=2026-10&limit=2`);

    const response = await history(account, query(String(first.nextCursor)));

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(INVALID_CURSOR);
  });

  it.each([
    ["a user filter", () => `&userId=${ada}`],
    ["a month filter", () => "&month=2026-10"],
  ])("rejects adding %s to an unfiltered traversal", async (_label, extra) => {
    const first = await historyOk(account, "?limit=2");

    const response = await history(account, `?cursor=${String(first.nextCursor)}${extra()}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(INVALID_CURSOR);
  });
});

describe("filter-scoped anchors", () => {
  it("accepts a constructed cursor whose anchor is in the account and the filtered set", async () => {
    const adaIds = await storedIds(account.id, { userId: ada });

    const page = await historyOk(account, `?cursor=${cursorFor(adaIds[0] ?? "", ada, null)}`);

    expect(page.decisions.map((decision) => decision.requestId)).toEqual(
      (await storedRequestIds(account.id, { userId: ada })).slice(1, 21),
    );
  });

  it.each([
    [
      "another user's decision under a user filter",
      async () => cursorFor((await storedIds(account.id, { userId: bob }))[0] ?? "", ada, null),
    ],
    [
      "another month's decision under a month filter",
      async () =>
        cursorFor((await storedIds(account.id, { month: "2026-10" }))[0] ?? "", null, "2026-09"),
    ],
    [
      "a decision outside both filters",
      async () =>
        cursorFor(
          (await storedIds(account.id, { userId: bob, month: "2026-10" }))[0] ?? "",
          ada,
          "2026-09",
        ),
    ],
    ["an unknown decision", () => Promise.resolve(cursorFor(UNKNOWN_ID, null, null))],
    ["another account's decision", () => Promise.resolve(cursorFor(otherDecisionId, null, null))],
    [
      "another account's decision under a month filter",
      () => Promise.resolve(cursorFor(otherDecisionId, null, "2026-10")),
    ],
    ["a users cursor", () => Promise.resolve(encodeCursor({ kind: "users", anchor: ada }))],
    [
      "a usage-users cursor",
      () =>
        Promise.resolve(
          encodeCursor({ kind: "usage-users", anchor: ada, month: "2026-10", currentMonth: true }),
        ),
    ],
    ["random text", () => Promise.resolve("not-a-cursor")],
    ["a future month in the cursor", () => Promise.resolve(cursorFor(UNKNOWN_ID, null, "2026-12"))],
  ])("answers %s with the one Invalid cursor response", async (_label, cursor) => {
    const response = await history(account, `?cursor=${encodeURIComponent(await cursor())}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(INVALID_CURSOR);
  });

  it.each([
    ["an unknown user", () => UNKNOWN_ID],
    ["another account's user", () => otherUser],
  ])("answers a cursor bound to %s with the identical 404", async (_label, userId) => {
    const anchor = (await storedIds(account.id))[0] ?? "";

    const response = await history(account, `?cursor=${cursorFor(anchor, userId(), null)}`);

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(USER_NOT_FOUND);
  });
});

describe("error precedence", () => {
  it("checks an explicit future month before the cursor", async () => {
    const response = await history(account, "?month=2099-01&cursor=not-a-cursor");

    expect(response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "month must not be in the future" },
    });
  });

  it("checks the cursor before the user", async () => {
    const response = await history(account, `?userId=${UNKNOWN_ID}&cursor=not-a-cursor`);

    expect(response.body).toBe(INVALID_CURSOR);
  });

  it("checks the user before the anchor", async () => {
    const response = await history(account, `?cursor=${cursorFor(UNKNOWN_ID, UNKNOWN_ID, null)}`);

    expect(response.body).toBe(USER_NOT_FOUND);
  });

  it.each([
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
    ["a decimal limit", "?limit=2.5"],
    ["a malformed user ID", "?userId=ada"],
    ["a malformed month", "?month=2026-9"],
    ["a repeated user ID", `?userId=${UNKNOWN_ID}&userId=${UNKNOWN_ID}`],
    ["an unknown parameter", "?accepted=true"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, query) => {
    const response = await history(account, query);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("isolation, query counts and clock reads", () => {
  it("never lists another account's decisions", async () => {
    const pages = await walk(other, "?limit=100");

    expect(pages.flatMap((page) => page.decisions.map((decision) => decision.userId))).toEqual([
      otherUser,
    ]);
    const own = (await walk(account, "?limit=100")).flatMap((page) => page.decisions);
    expect(own.map((decision) => decision.userId)).not.toContain(otherUser);
  });

  it("uses at most three queries per page, whatever its size", async () => {
    const query = vi.spyOn(integration.pool, "query");
    const counted = async (url: string) => {
      query.mockClear();
      const page = await historyOk(account, url);
      return { page, queries: query.mock.calls.length };
    };
    try {
      const plain = await counted("?limit=100");
      const small = await counted("?limit=1");
      const byUser = await counted(`?userId=${ada}&limit=1`);
      const continuation = await counted(`?cursor=${String(small.page.nextCursor)}&limit=100`);
      const userContinuation = await counted(`?cursor=${String(byUser.page.nextCursor)}`);

      expect([
        plain.queries,
        small.queries,
        byUser.queries,
        continuation.queries,
        userContinuation.queries,
      ]).toEqual([2, 2, 3, 3, 3]);
    } finally {
      query.mockRestore();
    }
  });

  it("reads the clock only when a month is in effect, and then once", async () => {
    const first = await historyOk(account, "?month=2026-10&limit=1");
    const reads = async (url: string) => {
      clockReads = 0;
      await historyOk(account, url);
      return clockReads;
    };

    expect(await reads("?limit=1")).toBe(0);
    expect(await reads("?month=2026-10&limit=1")).toBe(1);
    expect(await reads(`?cursor=${String(first.nextCursor)}`)).toBe(1);
    expect(await reads(`?cursor=${String(first.nextCursor)}&month=2026-10`)).toBe(1);
  });
});
