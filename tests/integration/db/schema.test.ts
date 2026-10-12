import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { typeParsers } from "../../../src/db/type-parsers.js";
import {
  migrateTestDatabase,
  resetTestDatabase,
  testDatabaseUrl,
} from "../../helpers/test-database.js";

const STARTER = "a0000000-0000-4000-8000-000000000001";
const PRO = "a0000000-0000-4000-8000-000000000002";
const BASIC = "b0000000-0000-4000-8000-000000000001";
const PREMIUM = "b0000000-0000-4000-8000-000000000002";
const NOW = "2026-10-12T10:00:00.000Z";

let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  await migrateTestDatabase();
  client = new pg.Client({ connectionString: testDatabaseUrl(), types: typeParsers });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

// Each test runs in its own transaction that is rolled back afterwards.
beforeEach(async () => {
  await client.query("BEGIN");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

interface PostgresError {
  readonly code: string;
  readonly constraint?: string;
  readonly message: string;
}

/** Runs a statement that must fail, inside a savepoint so the test transaction stays usable. */
async function violation(sql: string, params: unknown[] = []): Promise<PostgresError> {
  await client.query("SAVEPOINT expected_failure");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    return error as PostgresError;
  }
  throw new Error(`Expected the statement to fail: ${sql}`);
}

async function insertAccount(planId = STARTER): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO accounts (id, name, api_key_hash, plan_id, created_at, updated_at)
     VALUES ($1, 'Acme', $2, $3, $4, $4)`,
    [id, randomBytes(32), planId, NOW],
  );
  return id;
}

async function insertUser(accountId: string, planId = BASIC): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, account_id, name, plan_id, created_at, updated_at)
     VALUES ($1, $2, 'Alice', $3, $4, $4)`,
    [id, accountId, planId, NOW],
  );
  return id;
}

async function insertCustomPlan(ownerId: string, scope: "ACCOUNT" | "USER"): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO plans (id, owner_account_id, scope, name, monthly_allowance,
                        max_units_per_request, created_at, updated_at)
     VALUES ($1, $2, $3, 'Custom', 500, 10, $4, $4)`,
    [id, ownerId, scope, NOW],
  );
  return id;
}

interface DecisionValues {
  accountId: string;
  userId: string;
  requestId?: string;
  units?: number;
  accepted?: boolean;
  blockingRule?: string | null;
  blockingLevel?: string | null;
  accountUsedBefore?: number;
  userUsedBefore?: number;
  month?: string;
  processedAt?: string;
}

const INSERT_DECISION = `
  INSERT INTO consume_decisions (
    id, account_id, user_id, request_id, units, accepted, blocking_rule, blocking_level,
    account_plan_id, account_plan_name, account_monthly_allowance, account_max_units_per_request,
    user_plan_id, user_plan_name, user_monthly_allowance, user_max_units_per_request,
    account_used_before, user_used_before, month, processed_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
            '${STARTER}', 'Starter', 10000, 100, '${BASIC}', 'Basic', 1000, 20,
            $9, $10, $11, $12)`;

function decisionParams(values: DecisionValues): unknown[] {
  return [
    randomUUID(),
    values.accountId,
    values.userId,
    values.requestId ?? `req-${randomUUID()}`,
    values.units ?? 10,
    values.accepted ?? true,
    values.blockingRule ?? null,
    values.blockingLevel ?? null,
    values.accountUsedBefore ?? 0,
    values.userUsedBefore ?? 0,
    values.month ?? "2026-10-01",
    values.processedAt ?? NOW,
  ];
}

describe("predefined plans", () => {
  it("contains exactly the four approved plans with stable identifiers", async () => {
    const result = await client.query(
      `SELECT id, code, owner_account_id, scope, name, monthly_allowance, max_units_per_request,
              created_at
       FROM plans ORDER BY scope, monthly_allowance`,
    );

    expect(result.rows).toEqual([
      {
        id: STARTER,
        code: "starter",
        owner_account_id: null,
        scope: "ACCOUNT",
        name: "Starter",
        monthly_allowance: 10_000,
        max_units_per_request: 100,
        created_at: new Date("2026-10-12T00:00:00.000Z"),
      },
      {
        id: PRO,
        code: "pro",
        owner_account_id: null,
        scope: "ACCOUNT",
        name: "Pro",
        monthly_allowance: 100_000,
        max_units_per_request: 1_000,
        created_at: new Date("2026-10-12T00:00:00.000Z"),
      },
      {
        id: BASIC,
        code: "basic",
        owner_account_id: null,
        scope: "USER",
        name: "Basic",
        monthly_allowance: 1_000,
        max_units_per_request: 20,
        created_at: new Date("2026-10-12T00:00:00.000Z"),
      },
      {
        id: PREMIUM,
        code: "premium",
        owner_account_id: null,
        scope: "USER",
        name: "Premium",
        monthly_allowance: 10_000,
        max_units_per_request: 100,
        created_at: new Date("2026-10-12T00:00:00.000Z"),
      },
    ]);
  });

  it("cannot be updated or deleted", async () => {
    const update = await violation("UPDATE plans SET monthly_allowance = 1 WHERE code = 'basic'");
    expect(update.code).toBe("23001");
    expect(update.message).toContain('predefined plan "basic" is read-only');

    const removal = await violation("DELETE FROM plans WHERE code = 'starter'");
    expect(removal.code).toBe("23001");
    expect(removal.message).toContain("plans cannot be deleted");
  });
});

describe("plan constraints", () => {
  it.each([
    ["monthly_allowance", 0, "plans_monthly_allowance_range"],
    ["monthly_allowance", 1_000_000_001, "plans_monthly_allowance_range"],
    ["max_units_per_request", 0, "plans_max_units_per_request_range"],
    ["max_units_per_request", 1_000_000_001, "plans_max_units_per_request_range"],
  ])("rejects %s = %i", async (column, value, constraint) => {
    const accountId = await insertAccount();
    const planId = await insertCustomPlan(accountId, "USER");

    const error = await violation(`UPDATE plans SET ${column} = $1 WHERE id = $2`, [value, planId]);

    expect(error).toMatchObject({ code: "23514", constraint });
  });

  it("accepts limits at the 1 and 1,000,000,000 bounds", async () => {
    const accountId = await insertAccount();
    const planId = await insertCustomPlan(accountId, "USER");

    await client.query(
      "UPDATE plans SET monthly_allowance = 1000000000, max_units_per_request = 1 WHERE id = $1",
      [planId],
    );
  });

  it("requires a plan to be either predefined (code) or custom (owner), never both or neither", async () => {
    const accountId = await insertAccount();

    const neither = await violation(
      `INSERT INTO plans (id, scope, name, monthly_allowance, max_units_per_request, created_at, updated_at)
       VALUES ($1, 'USER', 'Orphan', 10, 1, $2, $2)`,
      [randomUUID(), NOW],
    );
    const both = await violation(
      `INSERT INTO plans (id, code, owner_account_id, scope, name, monthly_allowance,
                          max_units_per_request, created_at, updated_at)
       VALUES ($1, 'extra', $2, 'USER', 'Both', 10, 1, $3, $3)`,
      [randomUUID(), accountId, NOW],
    );

    expect(neither).toMatchObject({ code: "23514", constraint: "plans_predefined_xor_custom" });
    expect(both).toMatchObject({ code: "23514", constraint: "plans_predefined_xor_custom" });
  });

  it("rejects blank or untrimmed plan names", async () => {
    const accountId = await insertAccount();
    const planId = await insertCustomPlan(accountId, "USER");

    expect(await violation("UPDATE plans SET name = '   ' WHERE id = $1", [planId])).toMatchObject({
      code: "23514",
      constraint: "plans_name_format",
    });
    expect(
      await violation("UPDATE plans SET name = ' Padded' WHERE id = $1", [planId]),
    ).toMatchObject({ code: "23514", constraint: "plans_name_format" });
  });

  it("lets a custom plan change its name and limits but never its scope, owner or code", async () => {
    const accountId = await insertAccount();
    const otherAccountId = await insertAccount();
    const planId = await insertCustomPlan(accountId, "USER");

    await client.query(
      "UPDATE plans SET name = 'Renamed', monthly_allowance = 50, updated_at = $2 WHERE id = $1",
      [planId, "2026-10-13T00:00:00Z"],
    );

    for (const change of [
      "scope = 'ACCOUNT'",
      `owner_account_id = '${otherAccountId}'`,
      "created_at = created_at - interval '1 day'",
    ]) {
      const error = await violation(`UPDATE plans SET ${change} WHERE id = $1`, [planId]);
      expect(error.code).toBe("23001");
    }
    expect((await violation("DELETE FROM plans WHERE id = $1", [planId])).message).toContain(
      "plans cannot be deleted",
    );
  });
});

describe("accounts and users", () => {
  it("stores only a 32-byte unique API-key hash", async () => {
    const accountId = await insertAccount();
    const { rows } = await client.query<{ api_key_hash: Buffer }>(
      "SELECT api_key_hash FROM accounts WHERE id = $1",
      [accountId],
    );

    const duplicate = await violation(
      `INSERT INTO accounts (id, name, api_key_hash, plan_id, created_at, updated_at)
       VALUES ($1, 'Copy', $2, $3, $4, $4)`,
      [randomUUID(), rows[0]?.api_key_hash, STARTER, NOW],
    );
    const tooShort = await violation(
      `INSERT INTO accounts (id, name, api_key_hash, plan_id, created_at, updated_at)
       VALUES ($1, 'Short', $2, $3, $4, $4)`,
      [randomUUID(), randomBytes(31), STARTER, NOW],
    );

    expect(duplicate).toMatchObject({ code: "23505", constraint: "accounts_api_key_hash_key" });
    expect(tooShort).toMatchObject({ code: "23514", constraint: "accounts_api_key_hash_length" });
  });

  it("only allows ACCOUNT-scoped plans on accounts", async () => {
    const error = await violation(
      `INSERT INTO accounts (id, name, api_key_hash, plan_id, created_at, updated_at)
       VALUES ($1, 'Acme', $2, $3, $4, $4)`,
      [randomUUID(), randomBytes(32), BASIC, NOW],
    );

    expect(error).toMatchObject({ code: "23503", constraint: "accounts_plan_fkey" });
  });

  it("only allows USER-scoped plans on users", async () => {
    const accountId = await insertAccount();

    const error = await violation(
      `INSERT INTO users (id, account_id, name, plan_id, created_at, updated_at)
       VALUES ($1, $2, 'Bob', $3, $4, $4)`,
      [randomUUID(), accountId, PRO, NOW],
    );

    expect(error).toMatchObject({ code: "23503", constraint: "users_plan_fkey" });
  });

  it("prevents the fixed plan_scope assignment columns from drifting", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);

    expect(
      await violation("UPDATE accounts SET plan_scope = 'USER' WHERE id = $1", [accountId]),
    ).toMatchObject({ code: "23514", constraint: "accounts_plan_scope_is_account" });
    expect(
      await violation("UPDATE users SET plan_scope = 'ACCOUNT' WHERE id = $1", [userId]),
    ).toMatchObject({ code: "23514", constraint: "users_plan_scope_is_user" });
  });

  it("accepts custom plans of the matching scope and switching between plans", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);
    const userPlan = await insertCustomPlan(accountId, "USER");
    const accountPlan = await insertCustomPlan(accountId, "ACCOUNT");

    await client.query("UPDATE users SET plan_id = $1 WHERE id = $2", [userPlan, userId]);
    await client.query("UPDATE accounts SET plan_id = $1 WHERE id = $2", [accountPlan, accountId]);
    await client.query("UPDATE users SET plan_id = $1 WHERE id = $2", [PREMIUM, userId]);
  });
});

describe("monthly usage counters", () => {
  it("rejects negative usage and months that are not the first day", async () => {
    const accountId = await insertAccount();

    expect(
      await violation(
        "INSERT INTO account_monthly_usage (account_id, month, used) VALUES ($1, '2026-10-01', -1)",
        [accountId],
      ),
    ).toMatchObject({ code: "23514", constraint: "account_monthly_usage_used_not_negative" });
    expect(
      await violation(
        "INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, '2026-10-02')",
        [accountId],
      ),
    ).toMatchObject({ code: "23514", constraint: "account_monthly_usage_month_is_first_day" });
  });

  it("keeps one counter per account and month and starts at zero", async () => {
    const accountId = await insertAccount();
    await client.query(
      "INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, '2026-10-01')",
      [accountId],
    );

    const { rows } = await client.query<{ used: number; month: string }>(
      "SELECT used, month FROM account_monthly_usage WHERE account_id = $1",
      [accountId],
    );
    expect(rows).toEqual([{ used: 0, month: "2026-10-01" }]);
    expect(
      await violation(
        "INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, '2026-10-01')",
        [accountId],
      ),
    ).toMatchObject({ code: "23505", constraint: "account_monthly_usage_pkey" });
  });

  it("refuses a user counter that pairs a user with another account", async () => {
    const accountId = await insertAccount();
    const otherAccountId = await insertAccount();
    const userId = await insertUser(accountId);

    const error = await violation(
      "INSERT INTO user_monthly_usage (account_id, user_id, month) VALUES ($1, $2, '2026-10-01')",
      [otherAccountId, userId],
    );

    expect(error).toMatchObject({ code: "23503", constraint: "user_monthly_usage_user_fkey" });
  });
});

describe("consume decisions", () => {
  it("records an accepted decision with full plan snapshots", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);

    await client.query(INSERT_DECISION, decisionParams({ accountId, userId }));
  });

  it("enforces one decision per account and request ID, scoped per account", async () => {
    const accountId = await insertAccount();
    const otherAccountId = await insertAccount();
    const userId = await insertUser(accountId);
    const otherUserId = await insertUser(otherAccountId);
    await client.query(INSERT_DECISION, decisionParams({ accountId, userId, requestId: "r-1" }));

    const duplicate = await violation(
      INSERT_DECISION,
      decisionParams({ accountId, userId, requestId: "r-1" }),
    );
    await client.query(
      INSERT_DECISION,
      decisionParams({ accountId: otherAccountId, userId: otherUserId, requestId: "r-1" }),
    );

    expect(duplicate).toMatchObject({
      code: "23505",
      constraint: "consume_decisions_account_id_request_id_key",
    });
  });

  it("refuses a decision that pairs a user with another account", async () => {
    const accountId = await insertAccount();
    const otherAccountId = await insertAccount();
    const userId = await insertUser(accountId);

    const error = await violation(
      INSERT_DECISION,
      decisionParams({ accountId: otherAccountId, userId }),
    );

    expect(error).toMatchObject({ code: "23503", constraint: "consume_decisions_user_fkey" });
  });

  it.each([
    ["units above the user per-request limit", { units: 21 }],
    ["usage beyond the user monthly allowance", { units: 10, userUsedBefore: 995 }],
    ["usage beyond the account monthly allowance", { units: 10, accountUsedBefore: 9_995 }],
  ])("refuses an accepted decision with %s", async (_label, values) => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);

    const error = await violation(
      INSERT_DECISION,
      decisionParams({ accountId, userId, ...values }),
    );

    expect(error).toMatchObject({
      code: "23514",
      constraint: "consume_decisions_accepted_within_limits",
    });
  });

  it("accepts justified rejections and refuses unjustified ones", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);

    await client.query(
      INSERT_DECISION,
      decisionParams({
        accountId,
        userId,
        units: 25,
        accepted: false,
        blockingRule: "MAX_UNITS_PER_REQUEST",
        blockingLevel: "USER",
      }),
    );
    const unjustified = await violation(
      INSERT_DECISION,
      decisionParams({
        accountId,
        userId,
        units: 5,
        accepted: false,
        blockingRule: "MONTHLY_ALLOWANCE",
        blockingLevel: "ACCOUNT",
      }),
    );
    const missingReason = await violation(
      INSERT_DECISION,
      decisionParams({ accountId, userId, accepted: false }),
    );
    const reasonOnAcceptance = await violation(
      INSERT_DECISION,
      decisionParams({
        accountId,
        userId,
        blockingRule: "MONTHLY_ALLOWANCE",
        blockingLevel: "USER",
      }),
    );

    expect(unjustified).toMatchObject({
      code: "23514",
      constraint: "consume_decisions_rejection_justified",
    });
    expect(missingReason).toMatchObject({
      code: "23514",
      constraint: "consume_decisions_blocking_reason_presence",
    });
    expect(reasonOnAcceptance).toMatchObject({
      code: "23514",
      constraint: "consume_decisions_blocking_reason_presence",
    });
  });

  it("requires the month to be the UTC month of processed_at", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);

    // 2026-10-31T23:30:00-02:00 is 2026-11-01T01:30:00Z, so the UTC month is November.
    await client.query(
      INSERT_DECISION,
      decisionParams({
        accountId,
        userId,
        month: "2026-11-01",
        processedAt: "2026-10-31T23:30:00-02:00",
      }),
    );
    const error = await violation(
      INSERT_DECISION,
      decisionParams({
        accountId,
        userId,
        month: "2026-10-01",
        processedAt: "2026-10-31T23:30:00-02:00",
      }),
    );

    expect(error).toMatchObject({
      code: "23514",
      constraint: "consume_decisions_month_matches_processed_at",
    });
  });

  it("rejects malformed request IDs", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);

    for (const requestId of ["has space", "x".repeat(129), "semi;colon"]) {
      const error = await violation(
        INSERT_DECISION,
        decisionParams({ accountId, userId, requestId }),
      );
      expect(error).toMatchObject({
        code: "23514",
        constraint: "consume_decisions_request_id_format",
      });
    }
  });

  it("is append-only: decisions cannot be updated or deleted", async () => {
    const accountId = await insertAccount();
    const userId = await insertUser(accountId);
    await client.query(INSERT_DECISION, decisionParams({ accountId, userId }));

    const update = await violation(
      "UPDATE consume_decisions SET units = units WHERE account_id = $1",
      [accountId],
    );
    const removal = await violation("DELETE FROM consume_decisions WHERE account_id = $1", [
      accountId,
    ]);

    expect(update).toMatchObject({ code: "23001" });
    expect(update.message).toContain("consume decisions are immutable");
    expect(removal).toMatchObject({ code: "23001" });
  });
});

describe("schema conventions", () => {
  it("stores every timestamp as a timezone-aware timestamptz", async () => {
    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%\\_at' ESCAPE '\\'
       ORDER BY table_name, column_name`,
    );

    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.data_type).toBe("timestamp with time zone");
    }
  });
});
