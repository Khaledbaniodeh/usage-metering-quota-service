import type { Queryable } from "../../db/pool.js";
import type {
  ConsumeDecision,
  DecisionLevelSnapshot,
  QuotaLevel,
  QuotaRule,
} from "./consume.domain.js";

/** Unique constraint on consume_decisions (account_id, request_id): the idempotency authority. */
export const DECISION_REQUEST_ID_CONSTRAINT = "consume_decisions_account_id_request_id_key";

/** The plans applied to one consume request, read together in one statement. */
export interface PlanSnapshot {
  readonly account: Omit<DecisionLevelSnapshot, "usedBefore">;
  readonly user: Omit<DecisionLevelSnapshot, "usedBefore">;
}

export interface NewDecision extends ConsumeDecision {
  readonly id: string;
  readonly accountId: string;
}

/** A consume_decisions row as selected with DECISION_COLUMNS. */
export interface DecisionRow {
  readonly request_id: string;
  readonly user_id: string;
  readonly units: number;
  readonly accepted: boolean;
  readonly blocking_rule: QuotaRule | null;
  readonly blocking_level: QuotaLevel | null;
  readonly account_plan_id: string;
  readonly account_plan_name: string;
  readonly account_monthly_allowance: number;
  readonly account_max_units_per_request: number;
  readonly account_used_before: number;
  readonly user_plan_id: string;
  readonly user_plan_name: string;
  readonly user_monthly_allowance: number;
  readonly user_max_units_per_request: number;
  readonly user_used_before: number;
  readonly month: string;
  readonly processed_at: Date;
}

/** The columns of a stored decision, in the order DecisionRow expects. */
export const DECISION_COLUMNS = `request_id, user_id, units, accepted, blocking_rule, blocking_level,
  account_plan_id, account_plan_name, account_monthly_allowance, account_max_units_per_request,
  account_used_before, user_plan_id, user_plan_name, user_monthly_allowance,
  user_max_units_per_request, user_used_before, month, processed_at`;

/** The stored decision for this account and request ID, if any. */
export async function findDecision(
  db: Queryable,
  accountId: string,
  requestId: string,
): Promise<ConsumeDecision | undefined> {
  const result = await db.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS}
     FROM consume_decisions
     WHERE account_id = $1 AND request_id = $2`,
    [accountId, requestId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toDecision(row);
}

interface SnapshotRow {
  readonly account_plan_id: string;
  readonly account_plan_name: string;
  readonly account_monthly_allowance: number;
  readonly account_max_units_per_request: number;
  readonly user_plan_id: string;
  readonly user_plan_name: string;
  readonly user_monthly_allowance: number;
  readonly user_max_units_per_request: number;
}

/**
 * Reads the user (only within this account), the account and both assigned plans in ONE
 * statement, so both assignments and both plan versions come from the same committed snapshot.
 * Takes no row locks: plan edits and switches never wait for consumes. Undefined when the user
 * does not exist in this account.
 */
export async function readPlanSnapshot(
  db: Queryable,
  accountId: string,
  userId: string,
): Promise<PlanSnapshot | undefined> {
  const result = await db.query<SnapshotRow>(
    `SELECT ap.id AS account_plan_id, ap.name AS account_plan_name,
            ap.monthly_allowance AS account_monthly_allowance,
            ap.max_units_per_request AS account_max_units_per_request,
            up.id AS user_plan_id, up.name AS user_plan_name,
            up.monthly_allowance AS user_monthly_allowance,
            up.max_units_per_request AS user_max_units_per_request
     FROM users u
     JOIN accounts a ON a.id = u.account_id
     JOIN plans ap ON ap.id = a.plan_id
     JOIN plans up ON up.id = u.plan_id
     WHERE u.account_id = $1 AND u.id = $2`,
    [accountId, userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    account: {
      planId: row.account_plan_id,
      planName: row.account_plan_name,
      monthlyAllowance: row.account_monthly_allowance,
      maxUnitsPerRequest: row.account_max_units_per_request,
    },
    user: {
      planId: row.user_plan_id,
      planName: row.user_plan_name,
      monthlyAllowance: row.user_monthly_allowance,
      maxUnitsPerRequest: row.user_max_units_per_request,
    },
  };
}

/** Creates the month's account and user counters at zero when missing (account first). */
export async function ensureCounters(
  db: Queryable,
  accountId: string,
  userId: string,
  month: string,
): Promise<void> {
  await db.query(
    `INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, $2)
     ON CONFLICT (account_id, month) DO NOTHING`,
    [accountId, month],
  );
  await db.query(
    `INSERT INTO user_monthly_usage (account_id, user_id, month) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, month) DO NOTHING`,
    [accountId, userId, month],
  );
}

/**
 * Locks the account counter, then the user counter, and returns their latest committed values.
 * This is the only lock order used anywhere, so consumes cannot deadlock each other.
 */
export async function lockCounters(
  db: Queryable,
  accountId: string,
  userId: string,
  month: string,
): Promise<{ readonly accountUsed: number; readonly userUsed: number }> {
  const account = await db.query<{ used: number }>(
    `SELECT used FROM account_monthly_usage
     WHERE account_id = $1 AND month = $2
     FOR UPDATE`,
    [accountId, month],
  );
  const user = await db.query<{ used: number }>(
    `SELECT used FROM user_monthly_usage
     WHERE account_id = $1 AND user_id = $2 AND month = $3
     FOR UPDATE`,
    [accountId, userId, month],
  );
  const accountUsed = account.rows[0]?.used;
  const userUsed = user.rows[0]?.used;
  if (accountUsed === undefined || userUsed === undefined) {
    throw new Error("A monthly usage counter is missing after it was ensured");
  }
  return { accountUsed, userUsed };
}

/** Adds accepted units to both locked counters (account first). */
export async function incrementCounters(
  db: Queryable,
  accountId: string,
  userId: string,
  month: string,
  units: number,
): Promise<void> {
  await db.query(
    `UPDATE account_monthly_usage SET used = used + $3
     WHERE account_id = $1 AND month = $2`,
    [accountId, month, units],
  );
  await db.query(
    `UPDATE user_monthly_usage SET used = used + $4
     WHERE account_id = $1 AND user_id = $2 AND month = $3`,
    [accountId, userId, month, units],
  );
}

/** Appends the immutable decision record and returns it exactly as stored. */
export async function insertDecision(
  db: Queryable,
  decision: NewDecision,
): Promise<ConsumeDecision> {
  const result = await db.query<DecisionRow>(
    `INSERT INTO consume_decisions (
       id, account_id, user_id, request_id, units, accepted, blocking_rule, blocking_level,
       account_plan_id, account_plan_name, account_monthly_allowance,
       account_max_units_per_request, account_used_before,
       user_plan_id, user_plan_name, user_monthly_allowance,
       user_max_units_per_request, user_used_before,
       month, processed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20
     )
     RETURNING ${DECISION_COLUMNS}`,
    [
      decision.id,
      decision.accountId,
      decision.userId,
      decision.requestId,
      decision.units,
      decision.accepted,
      decision.blockingRule,
      decision.blockingLevel,
      decision.account.planId,
      decision.account.planName,
      decision.account.monthlyAllowance,
      decision.account.maxUnitsPerRequest,
      decision.account.usedBefore,
      decision.user.planId,
      decision.user.planName,
      decision.user.monthlyAllowance,
      decision.user.maxUnitsPerRequest,
      decision.user.usedBefore,
      decision.month,
      decision.processedAt,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("The decision insert returned no row");
  }
  return toDecision(row);
}

export function toDecision(row: DecisionRow): ConsumeDecision {
  return {
    requestId: row.request_id,
    userId: row.user_id,
    units: row.units,
    accepted: row.accepted,
    blockingRule: row.blocking_rule,
    blockingLevel: row.blocking_level,
    month: row.month,
    processedAt: row.processed_at,
    account: {
      planId: row.account_plan_id,
      planName: row.account_plan_name,
      monthlyAllowance: row.account_monthly_allowance,
      maxUnitsPerRequest: row.account_max_units_per_request,
      usedBefore: row.account_used_before,
    },
    user: {
      planId: row.user_plan_id,
      planName: row.user_plan_name,
      monthlyAllowance: row.user_monthly_allowance,
      maxUnitsPerRequest: row.user_max_units_per_request,
      usedBefore: row.user_used_before,
    },
  };
}
