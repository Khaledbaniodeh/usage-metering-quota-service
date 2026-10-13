import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { typeParsers } from "../../../src/db/type-parsers.js";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../helpers/account-harness.js";
import {
  deferred,
  interceptQueries,
  waitForLockWaiters,
  within,
} from "../../helpers/concurrency.js";
import { createTestUser, PREDEFINED_PLAN_IDS } from "../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../helpers/test-app.js";
import { testDatabaseUrl } from "../../helpers/test-database.js";

/**
 * Pagination under concurrent writes, on real PostgreSQL and without sleeps.
 *
 * Guarantees: no duplicates ever, and no gaps over a stable committed dataset. Documented
 * limitation, reproduced here deterministically: a row whose sequence number was allocated before
 * a page boundary but that commits after that page was read is missed by that traversal. For
 * decisions this is only possible across a UTC month boundary, because within one account and
 * month the account counter lock serializes insert and commit.
 */

let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let restoreQueries: (() => void) | undefined;
let requestSequence = 0;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
});

afterEach(() => {
  restoreQueries?.();
  restoreQueries = undefined;
  now = new Date("2026-10-13T12:00:00.000Z");
});

afterAll(async () => {
  await integration.close();
});

interface Page<Item> {
  nextCursor: string | null;
  items: Item[];
}

async function getJson(account: TestAccount, url: string): Promise<Record<string, unknown>> {
  const response = await authenticatedRequest(integration.app, account, { method: "GET", url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Record<string, unknown>>();
}

async function userPage(account: TestAccount, query: string): Promise<Page<string>> {
  const body = await getJson(account, `/v1/users${query}`);
  return {
    nextCursor: body.nextCursor as string | null,
    items: (body.users as { id: string }[]).map((user) => user.id),
  };
}

async function usageUserPage(account: TestAccount, query: string): Promise<Page<string>> {
  const body = await getJson(account, `/v1/usage/users${query}`);
  return {
    nextCursor: body.nextCursor as string | null,
    items: (body.users as { userId: string }[]).map((user) => user.userId),
  };
}

async function historyPage(account: TestAccount, query: string): Promise<Page<string>> {
  const body = await getJson(account, `/v1/history${query}`);
  return {
    nextCursor: body.nextCursor as string | null,
    items: (body.decisions as { requestId: string }[]).map((decision) => decision.requestId),
  };
}

function consume(account: TestAccount, userId: string, units = 1, requestId?: string) {
  requestSequence += 1;
  return authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/consume",
    payload: { userId, units, requestId: requestId ?? `pc-${String(requestSequence)}` },
  });
}

/** A user inserted in an open transaction: its seq is allocated now, its commit comes later. */
async function holdUncommittedUser(account: TestAccount) {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), types: typeParsers });
  await client.connect();
  const id = randomUUID();
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO users (id, account_id, name, plan_id, created_at, updated_at)
     VALUES ($1, $2, 'Late Commit', $3, $4, $4)`,
    [id, account.id, PREDEFINED_PLAN_IDS.basic, now],
  );
  return {
    id,
    commit: async () => {
      try {
        await client.query("COMMIT");
      } finally {
        await client.end();
      }
    },
  };
}

describe("no duplicates and no gaps while rows are inserted between pages", () => {
  it("users, oldest first: every existing user once, new users appended at the end", async () => {
    const account = await createTestAccount(integration.app, "Growing Users");
    const existing: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      existing.push((await createTestUser(integration.app, account, `U${String(index)}`)).id);
    }

    const seen: string[] = [];
    const added: string[] = [];
    let page = await userPage(account, "?limit=2");
    seen.push(...page.items);
    while (page.nextCursor !== null) {
      added.push((await createTestUser(integration.app, account, "New")).id);
      page = await userPage(account, `?cursor=${page.nextCursor}&limit=2`);
      seen.push(...page.items);
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, existing.length)).toEqual(existing);
    expect(seen.slice(existing.length)).toEqual(added);
  });

  it("history, newest first: every existing decision once, new decisions never interleaved", async () => {
    const account = await createTestAccount(integration.app, "Busy History");
    const user = await createTestUser(integration.app, account);
    for (let index = 0; index < 9; index += 1) {
      await consume(account, user.id);
    }
    const before = (await historyPage(account, "?limit=100")).items;

    const seen: string[] = [];
    let page = await historyPage(account, "?limit=2");
    seen.push(...page.items);
    while (page.nextCursor !== null) {
      await consume(account, user.id);
      page = await historyPage(account, `?cursor=${page.nextCursor}&limit=2`);
      seen.push(...page.items);
    }

    expect(seen).toEqual(before);
  });

  it("usage users, newest first: every existing user once, new users never interleaved", async () => {
    const account = await createTestAccount(integration.app, "Growing Usage");
    for (let index = 0; index < 6; index += 1) {
      await createTestUser(integration.app, account, `U${String(index)}`);
    }
    const before = (await usageUserPage(account, "?limit=100")).items;

    const seen: string[] = [];
    let page = await usageUserPage(account, "?limit=2");
    seen.push(...page.items);
    while (page.nextCursor !== null) {
      await createTestUser(integration.app, account, "New");
      page = await usageUserPage(account, `?cursor=${page.nextCursor}&limit=2`);
      seen.push(...page.items);
    }

    expect(seen).toEqual(before);
  });
});

describe("documented late-commit limitation (characterization)", () => {
  it("users: a user committed after its position was passed is missed by that traversal", async () => {
    const account = await createTestAccount(integration.app, "Late Users");
    const held = await holdUncommittedUser(account);
    const after = [
      (await createTestUser(integration.app, account, "A")).id,
      (await createTestUser(integration.app, account, "B")).id,
    ];

    const first = await userPage(account, "?limit=1");
    await held.commit();
    const second = await userPage(account, `?cursor=${String(first.nextCursor)}`);
    const fresh = await userPage(account, "");

    expect([...first.items, ...second.items]).toEqual(after);
    expect(fresh.items).toEqual([held.id, ...after]);
  });

  it("usage users: the same window exists newest first", async () => {
    const account = await createTestAccount(integration.app, "Late Usage Users");
    const older = (await createTestUser(integration.app, account, "Older")).id;
    const held = await holdUncommittedUser(account);
    const newer = (await createTestUser(integration.app, account, "Newer")).id;

    const first = await usageUserPage(account, "?limit=2");
    await held.commit();
    const fresh = await usageUserPage(account, "");

    expect(first.items).toEqual([newer, older]);
    expect(first.nextCursor).toBeNull();
    expect(fresh.items).toEqual([newer, held.id, older]);
  });

  it("decisions in one account and month cannot commit out of order", async () => {
    const account = await createTestAccount(integration.app, "Serialized");
    const user = await createTestUser(integration.app, account);
    const atCommit = deferred();
    const releaseCommit = deferred();
    let paused = false;
    restoreQueries = interceptQueries((text, run) => {
      if (text !== "COMMIT" || paused) {
        return undefined;
      }
      paused = true;
      atCommit.resolve();
      return releaseCommit.promise.then(run);
    });

    const first = consume(account, user.id, 1, "first");
    await within(atCommit.promise, 10_000, "the first decision reaching COMMIT");
    // The second request of the same month waits for the account counter lock.
    const second = consume(account, user.id, 1, "second");
    await waitForLockWaiters(1);
    const during = await historyPage(account, "");
    releaseCommit.resolve();
    await within(Promise.all([first, second]), 10_000, "both decisions");

    expect(during.items).toEqual([]);
    expect((await historyPage(account, "")).items).toEqual(["second", "first"]);
  });

  it("decisions straddling a UTC month boundary can commit out of order and be missed", async () => {
    const account = await createTestAccount(integration.app, "Month Edge");
    const user = await createTestUser(integration.app, account);
    now = new Date("2026-10-31T23:59:59.000Z");
    expect((await consume(account, user.id, 1, "older")).statusCode).toBe(200);

    const atCommit = deferred();
    const releaseCommit = deferred();
    let paused = false;
    restoreQueries = interceptQueries((text, run) => {
      if (text !== "COMMIT" || paused) {
        return undefined;
      }
      paused = true;
      atCommit.resolve();
      return releaseCommit.promise.then(run);
    });
    now = new Date("2026-10-31T23:59:59.999Z");
    const october = consume(account, user.id, 1, "october");
    await within(atCommit.promise, 10_000, "the October decision reaching COMMIT");
    now = new Date("2026-11-01T00:00:00.000Z");
    // November locks other counter rows, so it commits while October is still open.
    expect((await consume(account, user.id, 1, "november")).statusCode).toBe(200);

    const traversal = await historyPage(account, "?limit=100");
    releaseCommit.resolve();
    expect((await within(october, 10_000, "the October decision")).statusCode).toBe(200);
    const fresh = await historyPage(account, "?limit=100");

    expect(traversal.items).toEqual(["november", "older"]);
    expect(fresh.items).toEqual(["november", "october", "older"]);
  });
});
