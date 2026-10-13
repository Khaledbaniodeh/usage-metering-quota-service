import type { Queryable } from "../../db/pool.js";
import type { PlanSummary } from "../plans/plan.schemas.js";
import {
  planSummaryColumns,
  toPlanSummary,
  type PlanSummaryColumns,
} from "../plans/plans.repository.js";

export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly plan: PlanSummary;
}

export interface NewUser {
  readonly id: string;
  /** Always the authenticated account; never taken from the request. */
  readonly accountId: string;
  readonly name: string;
  /** Code of the predefined USER plan to assign. */
  readonly planCode: string;
  readonly now: Date;
}

interface UserRow extends PlanSummaryColumns {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Inserts the user and assigns the predefined plan with the given code in one statement, so the
 * plan is resolved and assigned atomically. Returns undefined when no such USER plan exists.
 */
export async function insertUserWithPredefinedPlan(
  db: Queryable,
  user: NewUser,
): Promise<UserRecord | undefined> {
  const result = await db.query<UserRow>(
    `WITH plan AS (
       SELECT id, code, name, scope, monthly_allowance, max_units_per_request
       FROM plans
       WHERE code = $5 AND scope = 'USER'
     ),
     inserted AS (
       INSERT INTO users (id, account_id, name, plan_id, created_at, updated_at)
       SELECT $1, $2, $3, plan.id, $4, $4 FROM plan
       RETURNING id, name, created_at, updated_at
     )
     SELECT inserted.id, inserted.name, inserted.created_at, inserted.updated_at,
            ${planSummaryColumns("plan")}
     FROM inserted CROSS JOIN plan`,
    [user.id, user.accountId, user.name, user.now, user.planCode],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toUserRecord(row);
}

/** A user of the given account; another account's user is indistinguishable from no user. */
export async function findUser(
  db: Queryable,
  accountId: string,
  userId: string,
): Promise<UserRecord | undefined> {
  const result = await db.query<UserRow>(
    `SELECT u.id, u.name, u.created_at, u.updated_at, ${planSummaryColumns("p")}
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     WHERE u.account_id = $1 AND u.id = $2`,
    [accountId, userId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toUserRecord(row);
}

/** All users of the account with their plans, in creation order, in a single query. */
export async function listUsers(db: Queryable, accountId: string): Promise<UserRecord[]> {
  const result = await db.query<UserRow>(
    `SELECT u.id, u.name, u.created_at, u.updated_at, ${planSummaryColumns("p")}
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     WHERE u.account_id = $1
     ORDER BY u.seq`,
    [accountId],
  );
  return result.rows.map(toUserRecord);
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan: toPlanSummary(row),
  };
}
