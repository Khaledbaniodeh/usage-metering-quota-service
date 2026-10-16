/**
 * The 13 quota invariants as direct SQL, shared by the integration tests
 * (tests/helpers/quota-invariants.ts) and the load-test invariant checker (load/scripts). Each
 * query counts violating rows over the whole database, so a consistent database yields all zeros
 * and a failure names exactly which invariant broke.
 */
export const INVARIANT_QUERIES = {
  negativeUsage: `
    SELECT (SELECT count(*) FROM account_monthly_usage WHERE used < 0)
         + (SELECT count(*) FROM user_monthly_usage WHERE used < 0)`,

  // Every counter equals the sum of the units of its accepted decisions: accepted decisions and
  // increments correspond exactly, and rejections incremented nothing.
  accountCounterMismatch: `
    SELECT count(*) FROM account_monthly_usage c
    WHERE c.used <> (SELECT coalesce(sum(d.units), 0) FROM consume_decisions d
                     WHERE d.account_id = c.account_id AND d.month = c.month AND d.accepted)`,
  // Set-based: accepted units are aggregated once per (account, user, month) and joined to the
  // counters, so the cost is one pass over the decisions however many counters exist. (A
  // correlated subquery here scanned every decision once per counter row: no index leads with
  // user_id.) A counter with no accepted decisions compares against 0; accepted decisions without
  // a counter row are acceptedWithoutCounter's job.
  userCounterMismatch: `
    SELECT count(*) FROM user_monthly_usage c
    LEFT JOIN (
      SELECT account_id, user_id, month, sum(units) AS used
      FROM consume_decisions
      WHERE accepted
      GROUP BY account_id, user_id, month
    ) d ON d.account_id = c.account_id AND d.user_id = c.user_id AND d.month = c.month
    WHERE c.used <> coalesce(d.used, 0)`,
  acceptedWithoutCounter: `
    SELECT count(*) FROM consume_decisions d
    WHERE d.accepted AND (
      NOT EXISTS (SELECT 1 FROM account_monthly_usage c
                  WHERE c.account_id = d.account_id AND c.month = d.month)
      OR NOT EXISTS (SELECT 1 FROM user_monthly_usage c
                     WHERE c.user_id = d.user_id AND c.month = d.month))`,

  // Decisions of one account (and of one user) in one month were made one at a time: each saw
  // exactly the accepted units of all earlier decisions as its "used before" value.
  accountSerializationBreak: `
    SELECT count(*) FROM (
      SELECT account_used_before,
             coalesce(sum(CASE WHEN accepted THEN units ELSE 0 END) OVER (
               PARTITION BY account_id, month ORDER BY seq
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS expected
      FROM consume_decisions) ordered
    WHERE account_used_before <> expected`,
  userSerializationBreak: `
    SELECT count(*) FROM (
      SELECT user_used_before,
             coalesce(sum(CASE WHEN accepted THEN units ELSE 0 END) OVER (
               PARTITION BY user_id, month ORDER BY seq
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS expected
      FROM consume_decisions) ordered
    WHERE user_used_before <> expected`,

  // The row checks of the schema, re-evaluated over every stored decision.
  acceptedOverLimit: `
    SELECT count(*) FROM consume_decisions
    WHERE accepted AND NOT (
      units <= account_max_units_per_request AND units <= user_max_units_per_request
      AND account_used_before + units <= account_monthly_allowance
      AND user_used_before + units <= user_monthly_allowance)`,
  unjustifiedRejection: `
    SELECT count(*) FROM consume_decisions
    WHERE NOT accepted AND NOT (
      (blocking_rule = 'MAX_UNITS_PER_REQUEST' AND blocking_level = 'USER'
        AND units > user_max_units_per_request)
      OR (blocking_rule = 'MAX_UNITS_PER_REQUEST' AND blocking_level = 'ACCOUNT'
        AND units > account_max_units_per_request)
      OR (blocking_rule = 'MONTHLY_ALLOWANCE' AND blocking_level = 'USER'
        AND user_used_before + units > user_monthly_allowance)
      OR (blocking_rule = 'MONTHLY_ALLOWANCE' AND blocking_level = 'ACCOUNT'
        AND account_used_before + units > account_monthly_allowance))`,
  // A rejection must name the FIRST failing rule in the fixed order, not just any failing one.
  rejectionNotFirstRule: `
    SELECT count(*) FROM consume_decisions
    WHERE NOT accepted AND (blocking_rule::text || ':' || blocking_level::text) <> CASE
      WHEN units > user_max_units_per_request THEN 'MAX_UNITS_PER_REQUEST:USER'
      WHEN units > account_max_units_per_request THEN 'MAX_UNITS_PER_REQUEST:ACCOUNT'
      WHEN user_used_before + units > user_monthly_allowance THEN 'MONTHLY_ALLOWANCE:USER'
      ELSE 'MONTHLY_ALLOWANCE:ACCOUNT' END`,

  duplicateRequestIds: `
    SELECT count(*) FROM (
      SELECT 1 FROM consume_decisions GROUP BY account_id, request_id HAVING count(*) > 1) d`,
  crossTenantDecisions: `
    SELECT count(*) FROM consume_decisions d
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id AND u.account_id = d.account_id)`,
  crossTenantUserCounters: `
    SELECT count(*) FROM user_monthly_usage c
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.account_id = c.account_id)`,
  monthNotUtcMonthOfProcessedAt: `
    SELECT count(*) FROM consume_decisions
    WHERE month <> date_trunc('month', processed_at AT TIME ZONE 'UTC')::date`,
} as const;

export type QuotaInvariant = keyof typeof INVARIANT_QUERIES;

export const INVARIANT_NAMES = Object.keys(INVARIANT_QUERIES) as QuotaInvariant[];

/** The one method of a pg client or pool the checker needs. */
export interface InvariantQueryable {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

function violationsOf(row: unknown): number {
  const value: unknown =
    typeof row === "object" && row !== null
      ? (row as { violations?: unknown }).violations
      : undefined;
  return typeof value === "number" ? value : -1;
}

/** Violation counts per invariant, in catalogue order; -1 if a query returned no count. */
export async function countInvariantViolations(
  db: InvariantQueryable,
): Promise<Record<QuotaInvariant, number>> {
  const counts = new Map<QuotaInvariant, number>();
  for (const [name, sql] of Object.entries(INVARIANT_QUERIES) as [QuotaInvariant, string][]) {
    const result = await db.query(`SELECT (${sql})::int AS violations`);
    counts.set(name, violationsOf(result.rows[0]));
  }
  return Object.fromEntries(counts) as Record<QuotaInvariant, number>;
}

/** The expected result of countInvariantViolations: no violation of any invariant. */
export function noViolations(): Record<QuotaInvariant, number> {
  return Object.fromEntries(INVARIANT_NAMES.map((name) => [name, 0])) as Record<
    QuotaInvariant,
    number
  >;
}
