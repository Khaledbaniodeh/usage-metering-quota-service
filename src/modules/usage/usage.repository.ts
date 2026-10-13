import type { Queryable } from "../../db/pool.js";

/** A month's usage counter with the limits of the plan assigned now, read in one statement. */
export interface UsageRow {
  readonly used: number;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

interface UsageRecord {
  readonly used: number;
  readonly monthly_allowance: number;
  readonly max_units_per_request: number;
}

function toUsageRow(row: UsageRecord): UsageRow {
  return {
    used: row.used,
    monthlyAllowance: row.monthly_allowance,
    maxUnitsPerRequest: row.max_units_per_request,
  };
}

/**
 * The account's usage for the month (`YYYY-MM-01`), 0 when it has no counter, with its current
 * plan's limits. One statement, so plan and usage come from the same snapshot.
 */
export async function readAccountUsage(
  db: Queryable,
  accountId: string,
  monthStart: string,
): Promise<UsageRow | undefined> {
  const result = await db.query<UsageRecord>(
    `SELECT coalesce(c.used, 0) AS used, p.monthly_allowance, p.max_units_per_request
     FROM accounts a
     JOIN plans p ON p.id = a.plan_id
     LEFT JOIN account_monthly_usage c ON c.account_id = a.id AND c.month = $2
     WHERE a.id = $1`,
    [accountId, monthStart],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toUsageRow(row);
}

/**
 * A user's usage for the month, 0 when it has no counter, with the user's current plan limits.
 * Undefined when the user does not exist in this account (another account's user included).
 */
export async function readUserUsage(
  db: Queryable,
  accountId: string,
  userId: string,
  monthStart: string,
): Promise<UsageRow | undefined> {
  const result = await db.query<UsageRecord>(
    `SELECT coalesce(c.used, 0) AS used, p.monthly_allowance, p.max_units_per_request
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN user_monthly_usage c ON c.user_id = u.id AND c.month = $3
     WHERE u.account_id = $1 AND u.id = $2`,
    [accountId, userId, monthStart],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toUsageRow(row);
}
