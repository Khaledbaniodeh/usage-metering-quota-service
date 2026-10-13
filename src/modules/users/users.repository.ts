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

/**
 * The internal position (seq) of a user of this account, used to resolve a cursor anchor. Another
 * account's user is indistinguishable from no user.
 */
export async function findUserSeq(
  db: Queryable,
  accountId: string,
  userId: string,
): Promise<number | undefined> {
  const result = await db.query<{ seq: number }>(
    "SELECT seq FROM users WHERE account_id = $1 AND id = $2",
    [accountId, userId],
  );
  return result.rows[0]?.seq;
}

/**
 * Up to `count` users of the account with their plans, oldest first (seq ASC), starting after the
 * user at position `afterSeq` when given. One query per page, whatever its size.
 */
export async function listUsersPage(
  db: Queryable,
  accountId: string,
  afterSeq: number | undefined,
  count: number,
): Promise<UserRecord[]> {
  const select = `SELECT u.id, u.name, u.created_at, u.updated_at, ${planSummaryColumns("p")}
     FROM users u
     JOIN plans p ON p.id = u.plan_id`;
  const result =
    afterSeq === undefined
      ? await db.query<UserRow>(
          `${select}
           WHERE u.account_id = $1
           ORDER BY u.seq ASC
           LIMIT $2`,
          [accountId, count],
        )
      : await db.query<UserRow>(
          `${select}
           WHERE u.account_id = $1 AND u.seq > $2
           ORDER BY u.seq ASC
           LIMIT $3`,
          [accountId, afterSeq, count],
        );
  return result.rows.map(toUserRecord);
}

/**
 * Assigns a plan to a user of the account in one statement. Only a user of this account can be
 * changed, and only to a predefined plan or the account's own custom plan with scope USER.
 * Reassigning the current plan succeeds without changing anything, updated_at included; a real
 * change sets updated_at to `now`.
 */
export async function assignUserPlan(
  db: Queryable,
  accountId: string,
  userId: string,
  planId: string,
  now: Date,
): Promise<PlanAssignment<UserRecord>> {
  const result = await db.query<AssignmentResultRow<UserRow>>(
    `WITH target AS (
       SELECT id FROM users WHERE account_id = $1 AND id = $2
     ),
     plan AS (
       SELECT id, code, name, scope, monthly_allowance, max_units_per_request
       FROM plans
       WHERE id = $3 AND (owner_account_id IS NULL OR owner_account_id = $1)
     ),
     updated AS (
       UPDATE users u
       SET plan_id = plan.id,
           updated_at = CASE WHEN u.plan_id = plan.id THEN u.updated_at ELSE $4 END
       FROM plan
       WHERE u.account_id = $1 AND u.id = $2 AND plan.scope = 'USER'
       RETURNING u.id, u.name, u.created_at, u.updated_at
     )
     SELECT EXISTS (SELECT 1 FROM target) AS target_found,
            EXISTS (SELECT 1 FROM plan) AS plan_visible,
            updated.id, updated.name, updated.created_at, updated.updated_at,
            ${planSummaryColumns("plan")}
     FROM (SELECT 1) AS one
     LEFT JOIN updated ON true
     LEFT JOIN plan ON updated.id IS NOT NULL`,
    [accountId, userId, planId, now],
  );
  return toPlanAssignment(result.rows[0], toUserRecord);
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
