import type { Queryable } from "../../db/pool.js";
import type { PlanSummary } from "../plans/plan.schemas.js";

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

interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly plan_id: string;
  readonly plan_code: string | null;
  readonly plan_name: string;
  readonly plan_scope: PlanSummary["scope"];
  readonly plan_monthly_allowance: number;
  readonly plan_max_units_per_request: number;
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
            plan.id AS plan_id, plan.code AS plan_code, plan.name AS plan_name,
            plan.scope AS plan_scope, plan.monthly_allowance AS plan_monthly_allowance,
            plan.max_units_per_request AS plan_max_units_per_request
     FROM inserted CROSS JOIN plan`,
    [account.id, account.name, account.apiKeyHash, account.now, account.planCode],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAccountRecord(row);
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan: {
      id: row.plan_id,
      code: row.plan_code,
      name: row.plan_name,
      scope: row.plan_scope,
      monthlyAllowance: row.plan_monthly_allowance,
      maxUnitsPerRequest: row.plan_max_units_per_request,
    },
  };
}
