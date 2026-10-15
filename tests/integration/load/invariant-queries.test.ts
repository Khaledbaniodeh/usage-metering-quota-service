import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countInvariantViolations,
  INVARIANT_QUERIES,
  noViolations,
} from "../../../load/lib/invariant-queries.js";
import type { DatasetProfile } from "../../../load/lib/profiles.js";
import { seedStatements } from "../../../load/lib/seed-sql.js";
import { resetAccountState } from "../../helpers/account-harness.js";
import { withTestClient } from "../../helpers/test-database.js";

/**
 * The invariant catalogue against real PostgreSQL, focused on the set-based userCounterMismatch.
 * The fixture is the load-test seed at a tiny scale (two tenants, five users, twelve months, with
 * rejections, and monthly volumes that differ), consistent by construction. Each corruption runs inside a transaction that is
 * rolled back, so cases never affect each other.
 */

const TINY: DatasetProfile = {
  name: "smoke",
  // 37, not 36: January gets one more row, so monthly sums differ and a missing month key shows.
  heavyUserDecisions: 37,
  backgroundUsers: 2,
  backgroundDecisionsPerUser: 12,
  noiseUsers: 2,
  noiseDecisions: 24,
  rejectEvery: 4,
};

const HEAVY_USER = "md5('umqs-bench:user:h:heavy')::uuid";
const HEAVY_ACCOUNT = "md5('umqs-bench:account:h')::uuid";
const NOISE_ACCOUNT = "md5('umqs-bench:account:n')::uuid";

async function count(client: pg.Client, sql: string): Promise<number> {
  const result = await client.query<{ violations: number }>(`SELECT (${sql})::int AS violations`);
  return result.rows[0]?.violations ?? -1;
}

/** Applies `corrupt`, measures with `measure`, then rolls everything back. */
async function afterCorruption<T>(
  corrupt: (client: pg.Client) => Promise<unknown>,
  measure: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withTestClient(async (client) => {
    await client.query("BEGIN");
    try {
      await corrupt(client);
      return await measure(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

const userMismatches = (client: pg.Client) => count(client, INVARIANT_QUERIES.userCounterMismatch);

beforeAll(async () => {
  await resetAccountState();
  await withTestClient(async (client) => {
    const statements = seedStatements(TINY, "s2", {
      heavyKeyHash: Buffer.alloc(32, 1),
      noiseKeyHash: Buffer.alloc(32, 2),
    });
    for (const statement of statements) {
      await client.query(statement.sql, [...statement.params]);
    }
  });
});

describe("the fixture", () => {
  it("spans tenants, users, months and rejections", async () => {
    const shape = await withTestClient(async (client) => {
      const result = await client.query<Record<string, number>>(
        `SELECT count(DISTINCT account_id)::int AS accounts, count(DISTINCT user_id)::int AS users,
                count(DISTINCT month)::int AS months, (count(*) FILTER (WHERE NOT accepted))::int AS rejected,
                (SELECT count(*)::int FROM user_monthly_usage) AS user_counters
         FROM consume_decisions`,
      );
      return result.rows[0];
    });

    expect(shape).toEqual({ accounts: 2, users: 5, months: 12, rejected: 12, user_counters: 60 });
  });
});

describe("the fixture's monthly variation", () => {
  it("gives the heavy user different accepted units in different months", async () => {
    // Without this, a check that ignored the month could still pass on consistent data.
    const perMonth = await withTestClient(async (client) => {
      const result = await client.query<{ month: string; used: number }>(
        `SELECT to_char(month, 'YYYY-MM') AS month, used::int AS used FROM user_monthly_usage
         WHERE user_id = ${HEAVY_USER} AND month IN ('2025-01-01', '2025-02-01') ORDER BY month`,
      );
      return result.rows;
    });

    expect(perMonth).toEqual([
      { month: "2025-01", used: 8 },
      { month: "2025-02", used: 3 },
    ]);
  });
});

describe("the invariant catalogue", () => {
  it("has exactly 13 checks and finds no violation in consistent data", async () => {
    const violations = await withTestClient((client) => countInvariantViolations(client));

    expect(Object.keys(INVARIANT_QUERIES)).toHaveLength(13);
    expect(violations).toEqual(noViolations());
  });
});

describe("userCounterMismatch", () => {
  it("detects a user counter that is off by one unit, and nothing else", async () => {
    const violations = await afterCorruption(
      (client) =>
        client.query(
          `UPDATE user_monthly_usage SET used = used + 1
           WHERE user_id = ${HEAVY_USER} AND month = '2025-01-01'`,
        ),
      (client) => countInvariantViolations(client),
    );

    expect(violations).toEqual({ ...noViolations(), userCounterMismatch: 1 });
  });

  it("detects a non-zero counter for a month without accepted decisions", async () => {
    const mismatches = await afterCorruption(
      (client) =>
        client.query(
          `INSERT INTO user_monthly_usage (account_id, user_id, month, used)
           VALUES (${HEAVY_ACCOUNT}, ${HEAVY_USER}, '2024-06-01', 7)`,
        ),
      userMismatches,
    );

    expect(mismatches).toBe(1);
  });

  it("accepts a zero counter for a month without decisions", async () => {
    const mismatches = await afterCorruption(
      (client) =>
        client.query(
          `INSERT INTO user_monthly_usage (account_id, user_id, month, used)
           VALUES (${HEAVY_ACCOUNT}, ${HEAVY_USER}, '2024-06-01', 0)`,
        ),
      userMismatches,
    );

    expect(mismatches).toBe(0);
  });

  it("counts accepted units only: a counter that includes rejected units is a mismatch", async () => {
    const { mismatches, updated } = await afterCorruption(
      async (client) => {
        const result = await client.query(
          `UPDATE user_monthly_usage c
           SET used = (SELECT sum(d.units) FROM consume_decisions d
                       WHERE d.user_id = c.user_id AND d.month = c.month)
           WHERE EXISTS (SELECT 1 FROM consume_decisions d
                         WHERE d.user_id = c.user_id AND d.month = c.month AND NOT d.accepted)`,
        );
        return result.rowCount;
      },
      async (client) => ({
        mismatches: await userMismatches(client),
        updated: await count(
          client,
          `SELECT count(DISTINCT (user_id, month)) FROM consume_decisions WHERE NOT accepted`,
        ),
      }),
    );

    expect(updated).toBeGreaterThan(0);
    expect(mismatches).toBe(updated);
  });

  it("compares each month separately", async () => {
    // Moving units between two months keeps the user's yearly total: a per-user check would pass.
    const mismatches = await afterCorruption(
      (client) =>
        client.query(
          `UPDATE user_monthly_usage SET used = used + CASE month WHEN '2025-01-01' THEN 1 ELSE -1 END
           WHERE user_id = ${HEAVY_USER} AND month IN ('2025-01-01', '2025-02-01')`,
        ),
      userMismatches,
    );

    expect(mismatches).toBe(2);
  });

  it("compares each user separately", async () => {
    // Swapping two users' counters keeps the account's monthly total: a per-account check would pass.
    const mismatches = await afterCorruption(
      (client) =>
        client.query(
          `WITH pair AS (
             SELECT user_id, used, lead(user_id) OVER (ORDER BY used) AS other_user,
                    lead(used) OVER (ORDER BY used) AS other_used
             FROM user_monthly_usage
             WHERE account_id = ${HEAVY_ACCOUNT} AND month = '2025-03-01'
           ), chosen AS (
             SELECT * FROM pair WHERE other_used IS NOT NULL AND other_used <> used LIMIT 1
           )
           UPDATE user_monthly_usage c SET used = CASE c.user_id
               WHEN chosen.user_id THEN chosen.other_used ELSE chosen.used END
           FROM chosen
           WHERE c.month = '2025-03-01' AND c.user_id IN (chosen.user_id, chosen.other_user)`,
        ),
      userMismatches,
    );

    expect(mismatches).toBe(2);
  });

  it("scopes by tenant: a corrupted noise-tenant counter is one mismatch", async () => {
    const mismatches = await afterCorruption(
      (client) =>
        client.query(
          `UPDATE user_monthly_usage SET used = used + 5
           WHERE ctid = (SELECT ctid FROM user_monthly_usage
                         WHERE account_id = ${NOISE_ACCOUNT} AND month = '2025-05-01' LIMIT 1)`,
        ),
      userMismatches,
    );

    expect(mismatches).toBe(1);
  });

  it("keeps cross-tenant counters impossible and their checks in place", async () => {
    // A counter naming the heavy user under the noise tenant violates the (account_id, user_id)
    // foreign key, so the account key in the join can never hide another tenant's units.
    const error = await withTestClient((client) =>
      client
        .query(
          `INSERT INTO user_monthly_usage (account_id, user_id, month, used)
           VALUES (${NOISE_ACCOUNT}, ${HEAVY_USER}, '2024-06-01', 0)`,
        )
        .then(
          () => undefined,
          (failure: unknown) => (failure as { code?: string }).code,
        ),
    );

    expect(error).toBe("23503");
    expect(Object.keys(INVARIANT_QUERIES)).toEqual(
      expect.arrayContaining(["crossTenantDecisions", "crossTenantUserCounters"]),
    );
  });
});

describe("mutation sensitivity of userCounterMismatch", () => {
  // Each mutant is derived from the shipped query by an exact replacement. On consistent data the
  // real query reports 0; each mutant must report violations, which proves the assertion
  // "consistent data has no violation" would fail if the query were broken this way.
  const mutate = (from: string, to: string) => {
    const mutated = INVARIANT_QUERIES.userCounterMismatch.replace(from, to);
    if (mutated === INVARIANT_QUERIES.userCounterMismatch) {
      throw new Error(`the mutation anchor "${from.trim()}" is not in the query`);
    }
    return mutated;
  };

  it.each([
    ["the accepted filter removed", "\n      WHERE accepted\n", "\n"],
    ["the month join key removed", " AND d.month = c.month", ""],
    ["the user join key removed", " AND d.user_id = c.user_id", ""],
  ])("reports violations with %s", async (_label, from, to) => {
    const counts = await withTestClient(async (client) => ({
      real: await count(client, INVARIANT_QUERIES.userCounterMismatch),
      mutant: await count(client, mutate(from, to)),
    }));

    expect(counts.real).toBe(0);
    expect(counts.mutant).toBeGreaterThan(0);
  });
});
