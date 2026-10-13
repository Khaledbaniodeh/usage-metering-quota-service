import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiKeyHeaders,
  authenticatedRequest,
  createTestAccount,
  createTestAccounts,
  expectAuthenticatedAs,
  readStoredAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import { createCapturingLogger } from "../../../helpers/logger.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

const UNAUTHORIZED_BODY = {
  error: { code: "UNAUTHORIZED", message: "A valid API key is required" },
};

/** Well-formed, but never issued: 32 fixed bytes rather than cryptographic randomness. */
const NEVER_ISSUED_KEY = `umqs_${Buffer.alloc(32, 0x5a).toString("base64url")}`;

let integration: IntegrationApp;
let logLines: string[];
let accounts: TestAccount[];

beforeAll(async () => {
  await resetAccountState();
  const capture = createCapturingLogger();
  logLines = capture.lines;
  integration = await createIntegrationApp({ logger: capture.logger });
  accounts = await createTestAccounts(integration.app, 3);
});

afterAll(async () => {
  await integration.close();
});

function getAccount(headers: Record<string, string | string[]>) {
  return integration.app.inject({ method: "GET", url: "/v1/account", headers });
}

describe("authentication with real API keys", () => {
  it("resolves each key to the account that owns it", async () => {
    for (const account of accounts) {
      await expectAuthenticatedAs(integration.app, account);
    }
  });

  it("returns the authenticated account with its Starter plan", async () => {
    const [account] = accounts;
    if (account === undefined) {
      throw new Error("expected test accounts");
    }

    const response = await authenticatedRequest(integration.app, account, {
      method: "GET",
      url: "/v1/account",
    });

    expect(response.json()).toEqual({
      id: account.id,
      name: account.name,
      createdAt: expect.any(String) as unknown,
      updatedAt: expect.any(String) as unknown,
      plan: {
        id: "a0000000-0000-4000-8000-000000000001",
        code: "starter",
        name: "Starter",
        scope: "ACCOUNT",
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
      },
    });
  });

  it("never lets one account's key authenticate as another account", async () => {
    for (const owner of accounts) {
      const response = await getAccount(apiKeyHeaders(owner));
      const resolvedId = response.json<{ id: string }>().id;

      for (const other of accounts.filter((candidate) => candidate.id !== owner.id)) {
        expect(resolvedId).not.toBe(other.id);
      }
      expect(resolvedId).toBe(owner.id);
    }
  });

  it.each([
    ["no X-API-Key header", {}],
    ["a malformed key", { "x-api-key": "umqs_not-a-real-key" }],
    ["a well-formed key that was never issued", { "x-api-key": NEVER_ISSUED_KEY }],
    ["a valid key presented twice", "duplicate"],
    ["a valid key with one character changed", "altered"],
    ["a valid key with a trailing space", "padded"],
  ] as const)("rejects %s with the identical 401 contract", async (_label, variant) => {
    const [account] = accounts;
    if (account === undefined) {
      throw new Error("expected test accounts");
    }
    const lastCharacter = account.apiKey.at(-1) === "A" ? "B" : "A";
    const headers =
      variant === "duplicate"
        ? { "x-api-key": [account.apiKey, account.apiKey] }
        : variant === "altered"
          ? { "x-api-key": `${account.apiKey.slice(0, -1)}${lastCharacter}` }
          : variant === "padded"
            ? { "x-api-key": `${account.apiKey} ` }
            : variant;

    const response = await getAccount(headers);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_BODY);
  });
});

describe("stored account state", () => {
  it("keeps only the SHA-256 digest of each key, never the key itself", async () => {
    for (const account of accounts) {
      const stored = await readStoredAccount(account.id);

      expect(stored).toEqual({
        id: account.id,
        name: account.name,
        planCode: "starter",
        apiKeyDigestHex: createHash("sha256").update(account.apiKey, "utf8").digest("hex"),
      });
    }

    const everything = await withTestClient(async (client) => {
      const result = await client.query<{ dump: string }>(
        `SELECT coalesce(string_agg(row_to_json(a)::text, E'\\n'), '') AS dump FROM accounts a`,
      );
      return result.rows[0]?.dump ?? "";
    });
    for (const account of accounts) {
      expect(everything).not.toContain(account.apiKey.slice("umqs_".length));
    }
  });

  it("never writes a raw key into the request logs", () => {
    const logs = logLines.join("\n");

    expect(logLines.some((line) => line.includes('"url":"/v1/account"'))).toBe(true);
    for (const account of accounts) {
      expect(logs).not.toContain(account.apiKey.slice("umqs_".length));
    }
  });
});

describe("keys across application instances", () => {
  it("authenticates keys issued by another instance, because only the database is shared", async () => {
    const issuer = await createIntegrationApp();
    let issued: TestAccount;
    try {
      issued = await createTestAccount(issuer.app, "Issued Elsewhere");
    } finally {
      await issuer.close();
    }

    await expectAuthenticatedAs(integration.app, issued);
  });
});

describe("concurrent account creation", () => {
  it("creates every account with a distinct ID and key", async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createTestAccount(integration.app, `Concurrent ${String(index)}`),
      ),
    );

    expect(new Set(created.map((account) => account.id)).size).toBe(20);
    expect(new Set(created.map((account) => account.apiKey)).size).toBe(20);
    const stored = await Promise.all(created.map((account) => readStoredAccount(account.id)));
    expect(new Set(stored.map((row) => row?.apiKeyDigestHex)).size).toBe(20);
    for (const account of created.slice(0, 3)) {
      await expectAuthenticatedAs(integration.app, account);
    }
  });
});
