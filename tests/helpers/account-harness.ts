import type { InjectOptions } from "fastify";
import { expect } from "vitest";
import type { App } from "../../src/app/build-app.js";
import { migrateTestDatabase, resetTestDatabase, withTestClient } from "./test-database.js";

/**
 * Account-isolation harness for integration tests. Accounts are created through the real
 * POST /v1/accounts endpoint; their raw API keys live only in these in-memory objects and are
 * never written to the database, files or logs by the harness.
 */

export interface TestAccount {
  readonly id: string;
  readonly name: string;
  /** Raw key returned once at creation; in memory only. */
  readonly apiKey: string;
}

export interface StoredAccount {
  readonly id: string;
  readonly name: string;
  readonly planCode: string | null;
  /** Hex SHA-256 digest as stored; the database holds nothing else about the key. */
  readonly apiKeyDigestHex: string;
}

let accountSequence = 0;

/** Drops and re-migrates the test database: a clean, isolated state with only predefined plans. */
export async function resetAccountState(): Promise<void> {
  await resetTestDatabase();
  await migrateTestDatabase();
}

export async function createTestAccount(app: App, name?: string): Promise<TestAccount> {
  accountSequence += 1;
  const response = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: { name: name ?? `Test Account ${String(accountSequence)}` },
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<TestAccount>();
  return { id: body.id, name: body.name, apiKey: body.apiKey };
}

export async function createTestAccounts(app: App, count: number): Promise<TestAccount[]> {
  const accounts: TestAccount[] = [];
  for (let index = 0; index < count; index += 1) {
    accounts.push(await createTestAccount(app));
  }
  return accounts;
}

export function apiKeyHeaders(account: Pick<TestAccount, "apiKey">): { "x-api-key": string } {
  return { "x-api-key": account.apiKey };
}

/** Sends a request authenticated as `account` (any explicit headers are kept). */
export async function authenticatedRequest(
  app: App,
  account: Pick<TestAccount, "apiKey">,
  options: InjectOptions,
) {
  return app.inject({ ...options, headers: { ...options.headers, ...apiKeyHeaders(account) } });
}

/** Asserts that the account's key authenticates as that account, and only as that account. */
export async function expectAuthenticatedAs(app: App, account: TestAccount): Promise<void> {
  const response = await authenticatedRequest(app, account, { method: "GET", url: "/v1/account" });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<{ id: string; name: string }>()).toMatchObject({
    id: account.id,
    name: account.name,
  });
}

/** The persisted account row, exposing the key only as its stored digest. */
export async function readStoredAccount(accountId: string): Promise<StoredAccount | undefined> {
  return withTestClient(async (client) => {
    const result = await client.query<StoredAccount>(
      `SELECT a.id, a.name, p.code AS "planCode", encode(a.api_key_hash, 'hex') AS "apiKeyDigestHex"
       FROM accounts a JOIN plans p ON p.id = a.plan_id
       WHERE a.id = $1`,
      [accountId],
    );
    return result.rows[0];
  });
}
