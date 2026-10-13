import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCapturingLogger } from "../../../helpers/logger.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import {
  migrateTestDatabase,
  resetTestDatabase,
  withTestClient,
} from "../../../helpers/test-database.js";

const NOW = new Date("2026-10-13T09:30:15.123Z");
const API_KEY_FORMAT = /^umqs_[A-Za-z0-9_-]{43}$/;

interface CreatedAccountBody {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  plan: Record<string, unknown>;
  apiKey: string;
}

let integration: IntegrationApp;
let logLines: string[];

beforeAll(async () => {
  await resetTestDatabase();
  await migrateTestDatabase();
  const capture = createCapturingLogger();
  logLines = capture.lines;
  integration = await createIntegrationApp({ logger: capture.logger, clock: () => NOW });
});

afterAll(async () => {
  await integration.close();
});

async function postAccount(payload: unknown) {
  return integration.app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: payload as object,
  });
}

async function createAccount(name: string): Promise<CreatedAccountBody> {
  const response = await postAccount({ name });
  expect(response.statusCode).toBe(201);
  return response.json<CreatedAccountBody>();
}

async function accountCount(): Promise<number> {
  return withTestClient(async (client) => {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM accounts",
    );
    return result.rows[0]?.count ?? -1;
  });
}

describe("POST /v1/accounts", () => {
  it("creates an account on the Starter plan and returns its API key once", async () => {
    const response = await postAccount({ name: "Acme" });
    const body = response.json<CreatedAccountBody>();

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as unknown,
      name: "Acme",
      createdAt: "2026-10-13T09:30:15.123Z",
      updatedAt: "2026-10-13T09:30:15.123Z",
      plan: {
        id: "a0000000-0000-4000-8000-000000000001",
        code: "starter",
        name: "Starter",
        scope: "ACCOUNT",
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
      },
      apiKey: expect.stringMatching(API_KEY_FORMAT) as unknown,
    });
  });

  it("persists the account with the Starter plan, clock timestamps and only the key digest", async () => {
    const created = await createAccount("Digest Check");

    const row = await withTestClient(async (client) => {
      const result = await client.query<{
        name: string;
        hash_hex: string;
        hash_bytes: number;
        is_starter: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT a.name, encode(a.api_key_hash, 'hex') AS hash_hex,
                octet_length(a.api_key_hash) AS hash_bytes,
                a.plan_id = (SELECT id FROM plans WHERE code = 'starter') AS is_starter,
                a.created_at, a.updated_at
         FROM accounts a WHERE a.id = $1`,
        [created.id],
      );
      return result.rows[0];
    });

    expect(row).toEqual({
      name: "Digest Check",
      hash_hex: createHash("sha256").update(created.apiKey, "utf8").digest("hex"),
      hash_bytes: 32,
      is_starter: true,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("never stores or logs the raw API key", async () => {
    const created = await createAccount("Secret Keeper");
    const token = created.apiKey.slice("umqs_".length);

    const storedRows = await withTestClient(async (client) => {
      const result = await client.query<{ row: string }>(
        "SELECT row_to_json(a)::text AS row FROM accounts a",
      );
      return result.rows.map(({ row }) => row).join("\n");
    });

    expect(storedRows).not.toContain(created.apiKey);
    expect(storedRows).not.toContain(token);
    expect(logLines.join("\n")).not.toContain(token);
  });

  it("issues a distinct ID and key per account and allows duplicate names", async () => {
    const first = await createAccount("Same Name");
    const second = await createAccount("Same Name");

    expect(first.id).not.toBe(second.id);
    expect(first.apiKey).not.toBe(second.apiKey);
    expect(second.name).toBe("Same Name");
  });

  it.each([
    ["a single character", "A"],
    ["100 characters", "x".repeat(100)],
    ["100 non-ASCII characters", "é".repeat(100)],
    ["inner spaces", "Acme  Corp Ltd"],
  ])("accepts a name with %s", async (_label, name) => {
    const created = await createAccount(name);

    expect(created.name).toBe(name);
  });

  it.each([
    ["an empty name", { name: "" }],
    ["101 characters", { name: "x".repeat(101) }],
    ["a leading space", { name: " Acme" }],
    ["a trailing space", { name: "Acme " }],
    ["a whitespace-only name", { name: "   " }],
    ["a line break", { name: "Ac\nme" }],
    ["a number", { name: 123 }],
    ["null", { name: null }],
    ["a missing name", {}],
    ["an unknown property", { name: "Acme", plan: "pro" }],
    ["an array body", [{ name: "Acme" }]],
  ])("rejects %s with 400 VALIDATION_ERROR and creates nothing", async (_label, payload) => {
    const before = await accountCount();

    const response = await postAccount(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
    expect(await accountCount()).toBe(before);
  });

  it("rejects an unsupported content type with 415", async () => {
    const response = await integration.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { "content-type": "application/xml" },
      payload: "<name>Acme</name>",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

describe("POST /v1/accounts with a colliding API-key digest", () => {
  it("retries with a fresh key against the real unique constraint", async () => {
    // Byte sequence: account A gets 0x01...; account B first draws 0x01... again (a digest that
    // already exists), then 0x02....
    const draws = [0x01, 0x01, 0x02];
    const colliding = await createIntegrationApp({
      clock: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, draws.shift() ?? 0xee),
    });
    try {
      const inject = (name: string) =>
        colliding.app.inject({ method: "POST", url: "/v1/accounts", payload: { name } });

      const first = (await inject("Collision A")).json<CreatedAccountBody>();
      const secondResponse = await inject("Collision B");
      const second = secondResponse.json<CreatedAccountBody>();

      expect(secondResponse.statusCode).toBe(201);
      expect(first.apiKey).toBe(`umqs_${Buffer.alloc(32, 0x01).toString("base64url")}`);
      expect(second.apiKey).toBe(`umqs_${Buffer.alloc(32, 0x02).toString("base64url")}`);
      expect(draws).toEqual([]);
    } finally {
      await colliding.close();
    }
  });
});
