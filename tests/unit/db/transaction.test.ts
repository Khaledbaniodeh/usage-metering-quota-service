import type pg from "pg";
import { describe, expect, it } from "vitest";
import { isLockNotAvailable, isUniqueViolation } from "../../../src/db/postgres-errors.js";
import { setLocalLockTimeout, withTransaction } from "../../../src/db/transaction.js";

interface FakeClient {
  readonly statements: string[];
  readonly released: unknown[];
  readonly source: { connect: () => Promise<pg.PoolClient> };
  readonly client: pg.PoolClient;
}

/** A pooled client that records statements and fails the ones listed in `failing`. */
function fakeClient(failing: Readonly<Record<string, Error>> = {}): FakeClient {
  const statements: string[] = [];
  const released: unknown[] = [];
  const failures = new Map(Object.entries(failing));
  const client = {
    query: (text: string) => {
      statements.push(text);
      const failure = failures.get(text);
      return failure === undefined ? Promise.resolve({ rows: [] }) : Promise.reject(failure);
    },
    release: (error?: unknown) => {
      released.push(error);
    },
  } as unknown as pg.PoolClient;
  return { statements, released, source: { connect: () => Promise.resolve(client) }, client };
}

describe("withTransaction", () => {
  it("commits and returns the result when the work succeeds", async () => {
    const fake = fakeClient();

    const result = await withTransaction(fake.source, async (client) => {
      await client.query("SELECT 1");
      return 42;
    });

    expect(result).toBe(42);
    expect(fake.statements).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT 1", "COMMIT"]);
    expect(fake.released).toEqual([undefined]);
  });

  it("rolls back and rethrows the original error when the work fails", async () => {
    const fake = fakeClient();
    const failure = new Error("work failed");

    await expect(withTransaction(fake.source, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(fake.statements).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]);
    expect(fake.released).toEqual([undefined]);
  });

  it("rolls back when COMMIT fails", async () => {
    const commitFailure = new Error("commit failed");
    const fake = fakeClient({ COMMIT: commitFailure });

    await expect(withTransaction(fake.source, () => Promise.resolve("done"))).rejects.toBe(
      commitFailure,
    );
    expect(fake.statements).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "COMMIT", "ROLLBACK"]);
    expect(fake.released).toEqual([undefined]);
  });

  it("destroys the connection instead of reusing it when ROLLBACK fails", async () => {
    const rollbackFailure = new Error("connection lost");
    const fake = fakeClient({ ROLLBACK: rollbackFailure });
    const failure = new Error("work failed");

    await expect(withTransaction(fake.source, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(fake.released).toEqual([rollbackFailure]);
  });
});

describe("setLocalLockTimeout", () => {
  it("sets the transaction-local lock timeout through a bound parameter", async () => {
    const calls: unknown[][] = [];
    const client = {
      query: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as pg.ClientBase;

    await setLocalLockTimeout(client, 250);

    expect(calls).toEqual([["SELECT set_config('lock_timeout', $1, true)", ["250ms"]]]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the invalid timeout %s", async (timeoutMs) => {
    const client = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.ClientBase;

    await expect(setLocalLockTimeout(client, timeoutMs)).rejects.toThrow(/positive integer/);
  });
});

describe("PostgreSQL error classification", () => {
  it("recognizes lock_not_available (55P03) only", () => {
    expect(isLockNotAvailable({ code: "55P03" })).toBe(true);
    expect(isLockNotAvailable({ code: "57014" })).toBe(false); // statement timeout
    expect(isLockNotAvailable({ code: "40P01" })).toBe(false); // deadlock
    expect(isLockNotAvailable({ code: "23505" })).toBe(false);
    expect(isLockNotAvailable(new Error("lock timeout"))).toBe(false);
    expect(isLockNotAvailable(null)).toBe(false);
  });

  it("recognizes a unique violation only for the named constraint", () => {
    const error = { code: "23505", constraint: "consume_decisions_account_id_request_id_key" };
    expect(isUniqueViolation(error, "consume_decisions_account_id_request_id_key")).toBe(true);
    expect(isUniqueViolation(error, "accounts_api_key_hash_key")).toBe(false);
    expect(
      isUniqueViolation({ code: "23503", constraint: error.constraint }, error.constraint),
    ).toBe(false);
  });
});
