import type { Queryable } from "../../db/pool.js";
import type { PlanScope, PlanSummary } from "./plan.schemas.js";

export interface PlanRecord extends PlanSummary {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewCustomPlan {
  readonly id: string;
  /** Always the authenticated account; never taken from the request. */
  readonly ownerAccountId: string;
  readonly scope: PlanScope;
  readonly name: string;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly now: Date;
}

export interface CustomPlanChanges {
  readonly name?: string;
  readonly monthlyAllowance?: number;
  readonly maxUnitsPerRequest?: number;
}

export type CustomPlanUpdate =
  | { readonly kind: "updated"; readonly plan: PlanRecord }
  | { readonly kind: "read-only" }
  | { readonly kind: "not-found" };

interface PlanRow {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly scope: PlanScope;
  readonly monthly_allowance: number;
  readonly max_units_per_request: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The plan columns a query selects (with `planSummaryColumns`) to embed a plan in another row. */
export interface PlanSummaryColumns {
  readonly plan_id: string;
  readonly plan_code: string | null;
  readonly plan_name: string;
  readonly plan_scope: PlanScope;
  readonly plan_monthly_allowance: number;
  readonly plan_max_units_per_request: number;
}

/** SELECT list for PlanSummaryColumns; `alias` is a table alias chosen by the calling query. */
export function planSummaryColumns(alias: string): string {
  return [
    `${alias}.id AS plan_id`,
    `${alias}.code AS plan_code`,
    `${alias}.name AS plan_name`,
    `${alias}.scope AS plan_scope`,
    `${alias}.monthly_allowance AS plan_monthly_allowance`,
    `${alias}.max_units_per_request AS plan_max_units_per_request`,
  ].join(", ");
}

export function toPlanSummary(row: PlanSummaryColumns): PlanSummary {
  return {
    id: row.plan_id,
    code: row.plan_code,
    name: row.plan_name,
    scope: row.plan_scope,
    monthlyAllowance: row.plan_monthly_allowance,
    maxUnitsPerRequest: row.plan_max_units_per_request,
  };
}

/** One row of updateCustomPlan: plan columns are NULL when no plan was updated (LEFT JOIN). */
type UpdateResultRow = { readonly [Column in keyof PlanRow]: PlanRow[Column] | null } & {
  readonly visible: boolean;
  readonly predefined: boolean;
};

const PLAN_COLUMNS =
  "id, code, name, scope, monthly_allowance, max_units_per_request, created_at, updated_at";

/** Predefined plans plus the account's own custom plans; never another account's plans. */
export async function listVisiblePlans(
  db: Queryable,
  accountId: string,
  scope: PlanScope | undefined,
): Promise<PlanRecord[]> {
  const result = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS}
     FROM plans
     WHERE (owner_account_id IS NULL OR owner_account_id = $1)
       AND ($2::quota_level IS NULL OR scope = $2::quota_level)
     ORDER BY owner_account_id IS NOT NULL, created_at, id`,
    [accountId, scope ?? null],
  );
  return result.rows.map(toPlanRecord);
}

export async function insertCustomPlan(db: Queryable, plan: NewCustomPlan): Promise<PlanRecord> {
  const result = await db.query<PlanRow>(
    `INSERT INTO plans (id, code, owner_account_id, scope, name, monthly_allowance,
                        max_units_per_request, created_at, updated_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $7)
     RETURNING ${PLAN_COLUMNS}`,
    [
      plan.id,
      plan.ownerAccountId,
      plan.scope,
      plan.name,
      plan.monthlyAllowance,
      plan.maxUnitsPerRequest,
      plan.now,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("INSERT ... RETURNING returned no row");
  }
  return toPlanRecord(row);
}

/**
 * Updates one of the account's own custom plans in a single statement. The same statement reports
 * whether the plan is visible at all, so a predefined plan (read-only) can be told apart from an
 * unknown or foreign plan (not found) without a separate, racy read.
 */
export async function updateCustomPlan(
  db: Queryable,
  accountId: string,
  planId: string,
  changes: CustomPlanChanges,
  now: Date,
): Promise<CustomPlanUpdate> {
  const result = await db.query<UpdateResultRow>(
    `WITH visible AS (
       SELECT id, owner_account_id IS NULL AS predefined
       FROM plans
       WHERE id = $1 AND (owner_account_id IS NULL OR owner_account_id = $2)
     ),
     updated AS (
       UPDATE plans
       SET name = COALESCE($3::text, name),
           monthly_allowance = COALESCE($4::integer, monthly_allowance),
           max_units_per_request = COALESCE($5::integer, max_units_per_request),
           updated_at = $6
       WHERE id = $1 AND owner_account_id = $2
       RETURNING ${PLAN_COLUMNS}
     )
     SELECT (visible.id IS NOT NULL) AS visible, coalesce(visible.predefined, false) AS predefined,
            updated.*
     FROM (SELECT 1) AS one
     LEFT JOIN visible ON true
     LEFT JOIN updated ON true`,
    [
      planId,
      accountId,
      changes.name ?? null,
      changes.monthlyAllowance ?? null,
      changes.maxUnitsPerRequest ?? null,
      now,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("The update statement returned no row");
  }
  if (row.id !== null) {
    // A non-null id means the UPDATE returned the row, so every plan column is present.
    return { kind: "updated", plan: toPlanRecord(row as PlanRow) };
  }
  return row.visible && row.predefined ? { kind: "read-only" } : { kind: "not-found" };
}

export function toPlanRecord(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scope: row.scope,
    monthlyAllowance: row.monthly_allowance,
    maxUnitsPerRequest: row.max_units_per_request,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
