import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeCursor } from "../../../../src/shared/cursor.js";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import { createTestUser } from "../../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

/** GET /v1/users keyset pagination: oldest first on users.seq, anchored on the user's UUID. */

const INVALID_CURSOR = '{"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}';

interface Page {
  users: { id: string; name: string }[];
  nextCursor: string | null;
}

let integration: IntegrationApp;
let big: TestAccount;
let bigUserIds: string[];
let other: TestAccount;
let otherUserId: string;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp();
  big = await createTestAccount(integration.app, "Many Users");
  bigUserIds = [];
  for (let index = 0; index < 45; index += 1) {
    bigUserIds.push((await createTestUser(integration.app, big, `Member ${String(index)}`)).id);
  }
  other = await createTestAccount(integration.app, "Other");
  otherUserId = (await createTestUser(integration.app, other, "Elsewhere")).id;
});

afterAll(async () => {
  await integration.close();
});

function list(account: TestAccount, query = "") {
  return authenticatedRequest(integration.app, account, {
    method: "GET",
    url: `/v1/users${query}`,
  });
}

async function listOk(account: TestAccount, query = ""): Promise<Page> {
  const response = await list(account, query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

/** Follows nextCursor to the end, with a page size per request (the last size repeats). */
async function walk(account: TestAccount, limits: readonly (number | undefined)[]) {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const limit = limits[Math.min(pages.length, limits.length - 1)];
    const params = new URLSearchParams();
    if (cursor !== null) {
      params.set("cursor", cursor);
    }
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const page = await listOk(account, query);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 100);
  return pages;
}

describe("GET /v1/users pagination", () => {
  it("returns 20 users per page by default, oldest first, ending with nextCursor null", async () => {
    const pages = await walk(big, [undefined]);

    expect(pages.map((page) => page.users.length)).toEqual([20, 20, 5]);
    expect(pages.map((page) => page.nextCursor === null)).toEqual([false, false, true]);
    expect(pages.flatMap((page) => page.users.map((user) => user.id))).toEqual(bigUserIds);
  });

  it("matches the stored order exactly: no duplicates and no gaps", async () => {
    const stored = await withTestClient(async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE account_id = $1 ORDER BY seq",
        [big.id],
      );
      return result.rows.map((row) => row.id);
    });

    const walked = (await walk(big, [7])).flatMap((page) => page.users.map((user) => user.id));

    expect(walked).toEqual(stored);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("returns a small account's complete list in one page, as before, plus nextCursor null", async () => {
    const small = await createTestAccount(integration.app, "Few Users");
    const ids = [
      (await createTestUser(integration.app, small, "One")).id,
      (await createTestUser(integration.app, small, "Two")).id,
    ];

    const page = await listOk(small);

    expect(page.users.map((user) => user.id)).toEqual(ids);
    expect(page.nextCursor).toBeNull();
  });

  it("accepts the limit bounds 1 and 100", async () => {
    const single = await listOk(big, "?limit=1");
    const all = await listOk(big, "?limit=100");

    expect(single.users.map((user) => user.id)).toEqual([bigUserIds[0]]);
    expect(single.nextCursor).not.toBeNull();
    expect(all.users).toHaveLength(45);
    expect(all.nextCursor).toBeNull();
  });

  it("allows the page size to change between pages", async () => {
    const pages = await walk(big, [3, 30, 1]);

    // 45 users: 3, then 30, then the remaining 12 one at a time.
    expect(pages.map((page) => page.users.length)).toEqual([3, 30, ...Array<number>(12).fill(1)]);
    expect(pages.flatMap((page) => page.users.map((user) => user.id))).toEqual(bigUserIds);
  });

  it("continues from a cursor alone, and includes users created after the traversal began", async () => {
    const growing = await createTestAccount(integration.app, "Growing");
    const first = await createTestUser(integration.app, growing, "First");
    const second = await createTestUser(integration.app, growing, "Second");
    const page1 = await listOk(growing, "?limit=1");

    const third = await createTestUser(integration.app, growing, "Third");
    const page2 = await listOk(growing, `?cursor=${String(page1.nextCursor)}`);

    expect(page1.users.map((user) => user.id)).toEqual([first.id]);
    expect(page2.users.map((user) => user.id)).toEqual([second.id, third.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("lets a caller start after one of its own users with a constructed cursor", async () => {
    const cursor = encodeCursor({ kind: "users", anchor: bigUserIds[42] ?? "" });

    const page = await listOk(big, `?cursor=${cursor}`);

    expect(page.users.map((user) => user.id)).toEqual(bigUserIds.slice(43));
  });

  it.each([
    ["0", "?limit=0"],
    ["101", "?limit=101"],
    ["a decimal", "?limit=1.0"],
    ["a sign", "?limit=%2B5"],
    ["a negative number", "?limit=-5"],
    ["an exponent", "?limit=1e1"],
    ["a leading zero", "?limit=05"],
    ["whitespace", "?limit=%205"],
    ["hexadecimal", "?limit=0x10"],
    ["an empty value", "?limit="],
    ["a repeated limit", "?limit=5&limit=5"],
    ["a repeated cursor", "?cursor=a&cursor=a"],
    ["an unknown parameter", "?offset=20"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, query) => {
    const response = await list(big, query);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["random text", () => "not-a-cursor"],
    ["an empty cursor", () => ""],
    [
      "a history cursor",
      () =>
        encodeCursor({ kind: "history", anchor: bigUserIds[0] ?? "", userId: null, month: null }),
    ],
    [
      "a usage-users cursor",
      () =>
        encodeCursor({
          kind: "usage-users",
          anchor: bigUserIds[0] ?? "",
          month: "2026-10",
          currentMonth: true,
        }),
    ],
    [
      "an unknown anchor",
      () => encodeCursor({ kind: "users", anchor: "00000000-0000-4000-8000-000000000000" }),
    ],
    [
      "another account's user as anchor",
      () => encodeCursor({ kind: "users", anchor: otherUserId }),
    ],
  ])("answers %s with the one Invalid cursor response", async (_label, cursor) => {
    const response = await list(big, `?cursor=${encodeURIComponent(cursor())}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(INVALID_CURSOR);
  });

  it("uses two queries for a first page and three for a continuation, whatever the page size", async () => {
    const query = vi.spyOn(integration.pool, "query");
    try {
      const first = await listOk(big, "?limit=100");
      const firstCount = query.mock.calls.length;
      query.mockClear();
      await listOk(big, "?limit=1");
      const smallCount = query.mock.calls.length;
      query.mockClear();
      const cursor = encodeCursor({ kind: "users", anchor: bigUserIds[0] ?? "" });
      await listOk(big, `?cursor=${cursor}&limit=100`);
      const continuationCount = query.mock.calls.length;

      expect(first.users).toHaveLength(45);
      // Authentication, then the page; a continuation adds the anchor lookup.
      expect([firstCount, smallCount, continuationCount]).toEqual([2, 2, 3]);
    } finally {
      query.mockRestore();
    }
  });
});
