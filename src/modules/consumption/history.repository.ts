import type { Queryable } from "../../db/pool.js";
import type { ConsumeDecision } from "./consume.domain.js";
import { DECISION_COLUMNS, toDecision, type DecisionRow } from "./consume.repository.js";

/** The effective history filters: null means "not filtered". */
export interface HistoryFilters {
  readonly userId: string | null;
  /** First day of the month (`YYYY-MM-01`). */
  readonly monthStart: string | null;
}

export interface StoredDecision {
  /** The decision's UUID: the history cursor anchor (never exposed otherwise). */
  readonly id: string;
  readonly decision: ConsumeDecision;
}

/**
 * Appends the filter conditions for `filters` to a statement whose `$1` is the account ID. The
 * conditions are constant SQL text with bound values, so there are exactly four statement shapes
 * per query: no filter, user only, month only, user and month.
 */
function filterConditions(filters: HistoryFilters, params: unknown[]): string {
  let conditions = "";
  if (filters.userId !== null) {
    params.push(filters.userId);
    conditions += ` AND user_id = $${String(params.length)}`;
  }
  if (filters.monthStart !== null) {
    params.push(filters.monthStart);
    conditions += ` AND month = $${String(params.length)}`;
  }
  return conditions;
}

export interface HistoryChecks {
  /** Whether the user filter names a user of this account (true when there is no user filter). */
  readonly userFound: boolean;
  /** The anchor's position, only when the anchor is a decision of this account that matches the filters. */
  readonly anchorSeq: number | undefined;
}

/**
 * One statement that checks the user filter and resolves the cursor anchor. The anchor must be a
 * decision of this account AND match the effective user and month filters: an anchor from another
 * account, or one outside the filtered set, does not resolve.
 */
export async function checkHistoryRequest(
  db: Queryable,
  accountId: string,
  filters: HistoryFilters,
  anchor: string | null,
): Promise<HistoryChecks> {
  const params: unknown[] = [accountId];
  let userFound = "true";
  if (filters.userId !== null) {
    params.push(filters.userId);
    userFound = `EXISTS (SELECT 1 FROM users WHERE account_id = $1 AND id = $${String(params.length)})`;
  }
  let anchorSeq = "NULL::bigint";
  if (anchor !== null) {
    params.push(anchor);
    const anchorParam = `$${String(params.length)}`;
    anchorSeq = `(SELECT seq FROM consume_decisions
                  WHERE account_id = $1 AND id = ${anchorParam}${filterConditions(filters, params)})`;
  }
  const result = await db.query<{ user_found: boolean; anchor_seq: number | null }>(
    `SELECT ${userFound} AS user_found, ${anchorSeq} AS anchor_seq`,
    params,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("The history check returned no row");
  }
  return { userFound: row.user_found, anchorSeq: row.anchor_seq ?? undefined };
}

/**
 * Up to `count` stored decisions of the account, newest first (seq DESC), matching the filters and
 * starting below position `beforeSeq` when given. Snapshots only: current plans are never read.
 */
export async function listHistoryPage(
  db: Queryable,
  accountId: string,
  filters: HistoryFilters,
  beforeSeq: number | undefined,
  count: number,
): Promise<StoredDecision[]> {
  const params: unknown[] = [accountId];
  let conditions = filterConditions(filters, params);
  if (beforeSeq !== undefined) {
    params.push(beforeSeq);
    conditions += ` AND seq < $${String(params.length)}`;
  }
  params.push(count);
  const result = await db.query<DecisionRow & { id: string }>(
    `SELECT id, ${DECISION_COLUMNS}
     FROM consume_decisions
     WHERE account_id = $1${conditions}
     ORDER BY seq DESC
     LIMIT $${String(params.length)}`,
    params,
  );
  return result.rows.map((row) => ({ id: row.id, decision: toDecision(row) }));
}
