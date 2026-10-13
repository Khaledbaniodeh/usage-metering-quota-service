import { describe, expect, it } from "vitest";
import type { Queryable } from "../../../../src/db/pool.js";
import {
  createAccountsService,
  MAX_API_KEY_ATTEMPTS,
} from "../../../../src/modules/accounts/accounts.service.js";
import { hashApiKey } from "../../../../src/modules/auth/api-key.js";

// The service against a scripted fake database: these tests cover the retry and failure paths
// that a real database can only reach through a SHA-256 collision. Real PostgreSQL behavior is
// covered by the integration tests.

const NOW = new Date("2026-10-13T12:00:00.000Z");

const STARTER_ROW = {
  plan_id: "a0000000-0000-4000-8000-000000000001",
  plan_code: "starter",
  plan_name: "Starter",
  plan_scope: "ACCOUNT",
  plan_monthly_allowance: 10_000,
  plan_max_units_per_request: 100,
};

const hashCollision = Object.assign(new Error("duplicate key value"), {
  code: "23505",
  constraint: "accounts_api_key_hash_key",
});

type Step = "collision" | "insert" | "no-plan" | Error;

function scriptedDatabase(steps: Step[]): { db: Queryable; params: unknown[][] } {
  const params: unknown[][] = [];
  const query = (_sql: string, values: unknown[]) => {
    params.push(values);
    const step = steps.shift();
    if (step === "collision") {
      return Promise.reject(hashCollision);
    }
    if (step instanceof Error) {
      return Promise.reject(step);
    }
    if (step === "no-plan") {
      return Promise.resolve({ rows: [] });
    }
    const [id, name] = values;
    return Promise.resolve({
      rows: [{ id, name, created_at: NOW, updated_at: NOW, ...STARTER_ROW }],
    });
  };
  return { db: { query } as unknown as Queryable, params };
}

function sequentialBytes(): (size: number) => Buffer {
  let next = 0;
  return (size) => Buffer.alloc(size, next++);
}

describe("createAccountsService.createAccount", () => {
  it("reads the clock once and stores only the digest of the returned key", async () => {
    let clockReads = 0;
    const { db, params } = scriptedDatabase(["insert"]);
    const accounts = createAccountsService({
      db,
      clock: () => {
        clockReads += 1;
        return NOW;
      },
      randomBytes: sequentialBytes(),
    });

    const { account, apiKey } = await accounts.createAccount("Acme");

    expect(clockReads).toBe(1);
    expect(account).toMatchObject({ name: "Acme", createdAt: NOW, updatedAt: NOW });
    expect(account.plan).toMatchObject({ code: "starter", scope: "ACCOUNT" });
    const [values] = params;
    expect(values?.[2]).toEqual(hashApiKey(apiKey));
    expect(values?.[3]).toBe(NOW);
    expect(values?.[4]).toBe("starter");
    expect(JSON.stringify(values)).not.toContain(apiKey);
  });

  it("retries with a fresh key when the digest collides, keeping the same account ID", async () => {
    const { db, params } = scriptedDatabase(["collision", "insert"]);
    const accounts = createAccountsService({
      db,
      clock: () => NOW,
      randomBytes: sequentialBytes(),
    });

    const { apiKey } = await accounts.createAccount("Acme");

    expect(params).toHaveLength(2);
    expect(params[0]?.[0]).toBe(params[1]?.[0]);
    expect(params[0]?.[2]).not.toEqual(params[1]?.[2]);
    expect(params[1]?.[2]).toEqual(hashApiKey(apiKey));
  });

  it("gives up after a bounded number of collisions without exposing any key", async () => {
    const steps: Step[] = Array.from({ length: MAX_API_KEY_ATTEMPTS }, () => "collision");
    const { db, params } = scriptedDatabase(steps);
    const accounts = createAccountsService({
      db,
      clock: () => NOW,
      randomBytes: sequentialBytes(),
    });

    const result = accounts.createAccount("Acme");

    await expect(result).rejects.toThrow(
      `Could not generate a unique API key after ${String(MAX_API_KEY_ATTEMPTS)} attempts`,
    );
    expect(params).toHaveLength(MAX_API_KEY_ATTEMPTS);
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain("umqs_");
    });
  });

  it("does not retry other database errors", async () => {
    const failure = Object.assign(new Error("other unique violation"), {
      code: "23505",
      constraint: "accounts_pkey",
    });
    const { db, params } = scriptedDatabase([failure]);
    const accounts = createAccountsService({ db, clock: () => NOW });

    await expect(accounts.createAccount("Acme")).rejects.toBe(failure);
    expect(params).toHaveLength(1);
  });

  it("fails clearly when the Starter plan is missing", async () => {
    const { db } = scriptedDatabase(["no-plan"]);
    const accounts = createAccountsService({ db, clock: () => NOW });

    await expect(accounts.createAccount("Acme")).rejects.toThrow(
      'The predefined account plan "starter" is missing',
    );
  });
});
