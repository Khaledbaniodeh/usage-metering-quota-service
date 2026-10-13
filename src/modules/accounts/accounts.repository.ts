import type { Queryable } from "../../db/pool.js";
import {
  toPlanAssignment,
  type AssignmentResultRow,
  type PlanAssignment,
} from "../plans/plan-assignment.js";
import type { PlanSummary } from "../plans/plan.schemas.js";
import {
  planSummaryColumns,
  toPlanSummary,
  type PlanSummaryColumns,
} from "../plans/plans.repository.js";

export interface AccountRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly plan: PlanSummary;
}

export interface NewAccount {
  readonly id: string;
  readonly name: string;
  readonly apiKeyHash: Buffer;
  /** Code of the predefined ACCOUNT plan to assign. */
  readonly planCode: string;
  readonly now: Date;
}

/** Unique constraint on accounts.api_key_hash (see 0001_baseline_schema.sql). */
export const API_KEY_HASH_CONSTRAINT = "accounts_api_key_hash_key";

interface AccountRow extends PlanSummaryColumns {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Inserts the account and assigns the predefined plan with the given code in one statement, so the
 * plan is resolved and assigned atomically. Returns undefined when no such ACCOUNT plan exists.
 */
export async function insertAccountWithPredefinedPlan(
  db: Queryable,
  account: NewAccount,
): Promise<AccountRecord | undefined> {
  const result = await db.query<AccountRow>(
    `WITH plan AS (
       SELECT id, code, name, scope, monthly_allowance, max_units_per_request
       FROM plans
       WHERE code = $5 AND scope = 'ACCOUNT'
     ),
     inserted AS (
       INSERT INTO accounts (id, name, api_key_hash, plan_id, created_at, updated_at)
       SELECT $1, $2, $3, plan.id, $4, $4 FROM plan
       RETURNING id, name, created_at, updated_at
     )
     SELECT inserted.id, inserted.name, inserted.created_at, inserted.updated_at,
            ${planSummaryColumns("plan")}
     FROM inserted CROSS JOIN plan`,
    [account.id, account.name, account.apiKeyHash, account.now, account.planCode],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAccountRecord(row);
}

export async function findAccountById(
  db: Queryable,
  accountId: string,
): Promise<AccountRecord | undefined> {
  const result = await db.query<AccountRow>(
    `SELECT a.id, a.name, a.created_at, a.updated_at, ${planSummaryColumns("p")}
     FROM accounts a
     JOIN plans p ON p.id = a.plan_id
     WHERE a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAccountRecord(row);
}

/** Resolves an API-key digest to its account ID (an index lookup on the unique constraint). */
export async function findAccountIdByApiKeyHash(
  db: Queryable,
  apiKeyHash: Buffer,
): Promise<string | undefined> {
  const result = await db.query<{ id: string }>("SELECT id FROM accounts WHERE api_key_hash = $1", [
    apiKeyHash,
  ]);
  return result.rows[0]?.id;
}

/**
 * Assigns a plan to the account in one statement. Only a predefined plan or the account's own
 * custom plan with scope ACCOUNT is assigned. Reassigning the current plan succeeds without
 * changing anything, updated_at included; a real change sets updated_at to `now`.
 */
export async function assignAccountPlan(
  db: Queryable,
  accountId: string,
  planId: string,
  now: Date,
): Promise<PlanAssignment<AccountRecord>> {
  const result = await db.query<AssignmentResultRow<AccountRow>>(
    `WITH target AS (
       SELECT id FROM accounts WHERE id = $1
     ),
     plan AS (
       SELECT id, code, name, scope, monthly_allowance, max_units_per_request
       FROM plans
       WHERE id = $2 AND (owner_account_id IS NULL OR owner_account_id = $1)
     ),
     updated AS (
       UPDATE accounts a
       SET plan_id = plan.id,
           updated_at = CASE WHEN a.plan_id = plan.id THEN a.updated_at ELSE $3 END
       FROM plan
       WHERE a.id = $1 AND plan.scope = 'ACCOUNT'
       RETURNING a.id, a.name, a.created_at, a.updated_at
     )
     SELECT EXISTS (SELECT 1 FROM target) AS target_found,
            EXISTS (SELECT 1 FROM plan) AS plan_visible,
            updated.id, updated.name, updated.created_at, updated.updated_at,
            ${planSummaryColumns("plan")}
     FROM (SELECT 1) AS one
     LEFT JOIN updated ON true
     LEFT JOIN plan ON updated.id IS NOT NULL`,
    [accountId, planId, now],
  );
  return toPlanAssignment(result.rows[0], toAccountRecord);
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan: toPlanSummary(row),
  };
}
