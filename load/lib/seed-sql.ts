import {
  REJECTED_UNITS,
  SEED_MONTHS,
  SEED_PLAN_LIMITS,
  validateProfile,
  type DatasetProfile,
  type DatasetShape,
} from "./profiles.js";

/**
 * The seed as an ordered list of parameterized SQL statements. Every variable value travels as a
 * bound parameter; the SQL text is constant. Parameters that appear only in a select list are cast
 * explicitly: PostgreSQL would otherwise resolve them as text, which a bytea or timestamptz column
 * refuses. Identifiers are md5-derived UUIDs of fixed labels, so
 * every run produces identical rows (apart from the API-key digests, which are secrets).
 *
 * Decisions are inserted per tenant and month in `k` order, so `seq` follows time, and the
 * "used before" values are computed with window sums: exactly the serialized sequence the
 * invariant checker verifies afterwards.
 */

export interface SeedStatement {
  readonly label: string;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Tenants of the dataset: H is measured, N only makes account_id selective. */
export const TENANTS = {
  heavy: { code: "h", name: "Benchmark heavy tenant" },
  noise: { code: "n", name: "Benchmark noise tenant" },
} as const;

export const SEED_CREATED_AT = "2024-12-15T00:00:00.000Z";

/** The UUID of a fixed seed label, as the SQL computes it. */
export const LABEL_UUID_SQL = "md5('umqs-bench:' || $LABEL)::uuid";

const id = (param: string) => LABEL_UUID_SQL.replace("$LABEL", param);

export const LABELS = {
  account: (tenant: string) => `account:${tenant}`,
  accountPlan: (tenant: string) => `plan:${tenant}:account`,
  userPlan: (tenant: string) => `plan:${tenant}:user`,
  heavyUser: "user:h:heavy",
  backgroundUserPrefix: "user:h:bg:",
  noiseUserPrefix: "user:n:",
} as const;

const SETUP_SQL = {
  accounts: `
    INSERT INTO accounts (id, name, api_key_hash, plan_id, created_at, updated_at)
    SELECT ${id("$1")}, $2::text, $3::bytea, p.id, $7::timestamptz, $7::timestamptz FROM plans p WHERE p.code = 'starter'
    UNION ALL
    SELECT ${id("$4")}, $5::text, $6::bytea, p.id, $7::timestamptz, $7::timestamptz FROM plans p WHERE p.code = 'starter'`,
  plans: `
    INSERT INTO plans (id, code, owner_account_id, scope, name, monthly_allowance,
                       max_units_per_request, created_at, updated_at)
    SELECT ${id("t.plan_label")}, NULL, ${id("t.account_label")}, t.scope::quota_level, t.name,
           t.allowance, t.max_units, $1::timestamptz, $1::timestamptz
    FROM (VALUES
      ($2, $3, 'ACCOUNT', 'Benchmark account', $6::int, $7::int),
      ($2, $4, 'USER', 'Benchmark user', $8::int, $9::int),
      ($5, $10, 'ACCOUNT', 'Benchmark account', $6::int, $7::int),
      ($5, $11, 'USER', 'Benchmark user', $8::int, $9::int)
    ) AS t(account_label, plan_label, scope, name, allowance, max_units)`,
  accountPlans: `
    UPDATE accounts SET plan_id = ${id("$2 || ':account'")}, updated_at = $3
    WHERE id = ${id("$1")}`,
  users: `
    INSERT INTO users (id, account_id, name, plan_id, created_at, updated_at)
    SELECT ${id("u.label")}, ${id("u.account_label")}, u.name, ${id("u.plan_label")}, $1::timestamptz, $1::timestamptz
    FROM (
      SELECT 0 AS ord, $2::text AS label, $3::text AS account_label, 'Heavy user' AS name,
             $4::text AS plan_label
      UNION ALL
      SELECT i, $5 || i, $3, 'Background user ' || i, $4 FROM generate_series(1, $6::int) AS i
      UNION ALL
      SELECT 1000000 + i, $7 || i, $8, 'Noise user ' || i, $9 FROM generate_series(1, $10::int) AS i
    ) AS u
    ORDER BY u.ord`,
} as const;

/**
 * One tenant-month of decisions. $1 account label, $2 month, $3 tenant code, $4 primary-user label
 * (or NULL), $5 primary count, $6 other-user label prefix, $7 other-user count, $8 other count,
 * $9 append others after the primary rows (else interleave evenly), $10 rejectEvery,
 * $11 rejected units.
 */
export const DECISIONS_SQL = `
  WITH tenant AS (
    SELECT a.id AS account_id, ap.id AS account_plan_id, ap.name AS account_plan_name,
           ap.monthly_allowance AS account_allowance, ap.max_units_per_request AS account_max,
           up.id AS user_plan_id, up.name AS user_plan_name,
           up.monthly_allowance AS user_allowance, up.max_units_per_request AS user_max
    FROM accounts a
    JOIN plans ap ON ap.id = a.plan_id
    -- Each seeded account owns exactly one custom USER plan.
    JOIN plans up ON up.owner_account_id = a.id AND up.scope = 'USER'
    WHERE a.id = ${id("$1")}
  ),
  spread AS (
    SELECT k,
           CASE WHEN $9::boolean THEN k >= $5::bigint
                ELSE ((k + 1) * $8::bigint) / ($5::bigint + $8::bigint)
                     > (k * $8::bigint) / ($5::bigint + $8::bigint) END AS is_other,
           CASE WHEN $9::boolean THEN k - $5::bigint + 1
                ELSE ((k + 1) * $8::bigint) / ($5::bigint + $8::bigint) END AS other_rank
    FROM generate_series(0::bigint, $5::bigint + $8::bigint - 1) AS k
  ),
  shaped AS (
    SELECT s.k,
           CASE WHEN s.is_other THEN ${id("$6 || (((s.other_rank - 1) % $7::bigint) + 1)")}
                ELSE ${id("$4")} END AS user_id,
           (s.k % $10::bigint) = $10::bigint - 1 AS rejected,
           'seed-' || $3 || '-' || to_char($2::date, 'YYYYMM') || '-' || lpad(s.k::text, 9, '0')
             AS request_id
    FROM spread s
  ),
  decided AS (
    SELECT sh.*,
           CASE WHEN sh.rejected THEN $11::int ELSE 1 + (sh.k % 10)::int END AS units,
           NOT sh.rejected AS accepted
    FROM shaped sh
  ),
  sequenced AS (
    SELECT d.*,
           coalesce(sum(CASE WHEN d.accepted THEN d.units ELSE 0 END) OVER (
             ORDER BY d.k ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS account_used_before,
           coalesce(sum(CASE WHEN d.accepted THEN d.units ELSE 0 END) OVER (
             PARTITION BY d.user_id ORDER BY d.k
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS user_used_before,
           count(*) OVER () AS total
    FROM decided d
  )
  INSERT INTO consume_decisions (
    id, account_id, user_id, request_id, units, accepted, blocking_rule, blocking_level,
    account_plan_id, account_plan_name, account_monthly_allowance, account_max_units_per_request,
    user_plan_id, user_plan_name, user_monthly_allowance, user_max_units_per_request,
    account_used_before, user_used_before, month, processed_at)
  SELECT md5('umqs-bench:decision:' || q.request_id)::uuid, t.account_id, q.user_id, q.request_id,
         q.units, q.accepted,
         CASE WHEN q.accepted THEN NULL ELSE 'MAX_UNITS_PER_REQUEST'::quota_rule END,
         CASE WHEN q.accepted THEN NULL ELSE 'USER'::quota_level END,
         t.account_plan_id, t.account_plan_name, t.account_allowance, t.account_max,
         t.user_plan_id, t.user_plan_name, t.user_allowance, t.user_max,
         q.account_used_before, q.user_used_before, $2::date,
         ($2::date::timestamp AT TIME ZONE 'UTC')
           + ((($2::date + interval '1 month') - $2::date) * q.k / q.total)
  FROM sequenced q CROSS JOIN tenant t
  ORDER BY q.k`;

export const COUNTERS_SQL = {
  account: `
    INSERT INTO account_monthly_usage (account_id, month, used)
    SELECT account_id, month, coalesce(sum(units) FILTER (WHERE accepted), 0)
    FROM consume_decisions GROUP BY account_id, month`,
  user: `
    INSERT INTO user_monthly_usage (account_id, user_id, month, used)
    SELECT account_id, user_id, month, coalesce(sum(units) FILTER (WHERE accepted), 0)
    FROM consume_decisions GROUP BY account_id, user_id, month`,
} as const;

/** Splits `total` over the months as evenly as possible (earlier months take the remainder). */
export function perMonth(total: number, months: number = SEED_MONTHS.length): number[] {
  const base = Math.floor(total / months);
  const remainder = total % months;
  return Array.from({ length: months }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

export interface SeedSecrets {
  /** SHA-256 digests of the tenants' API keys; the keys themselves never reach SQL. */
  readonly heavyKeyHash: Buffer;
  readonly noiseKeyHash: Buffer;
}

/** The complete seed, in execution order. */
export function seedStatements(
  input: DatasetProfile,
  shape: DatasetShape,
  secrets: SeedSecrets,
): SeedStatement[] {
  const profile = validateProfile(input);
  const { heavy, noise } = TENANTS;
  const limits = SEED_PLAN_LIMITS;
  const statements: SeedStatement[] = [
    {
      label: "accounts",
      sql: SETUP_SQL.accounts,
      params: [
        LABELS.account(heavy.code),
        heavy.name,
        secrets.heavyKeyHash,
        LABELS.account(noise.code),
        noise.name,
        secrets.noiseKeyHash,
        SEED_CREATED_AT,
      ],
    },
    {
      label: "plans",
      sql: SETUP_SQL.plans,
      params: [
        SEED_CREATED_AT,
        LABELS.account(heavy.code),
        LABELS.accountPlan(heavy.code),
        LABELS.userPlan(heavy.code),
        LABELS.account(noise.code),
        limits.account.monthlyAllowance,
        limits.account.maxUnitsPerRequest,
        limits.user.monthlyAllowance,
        limits.user.maxUnitsPerRequest,
        LABELS.accountPlan(noise.code),
        LABELS.userPlan(noise.code),
      ],
    },
    ...[heavy.code, noise.code].map((code) => ({
      label: `account plan ${code}`,
      sql: SETUP_SQL.accountPlans,
      params: [LABELS.account(code), `plan:${code}`, SEED_CREATED_AT],
    })),
    {
      label: "users",
      sql: SETUP_SQL.users,
      params: [
        SEED_CREATED_AT,
        LABELS.heavyUser,
        LABELS.account(heavy.code),
        LABELS.userPlan(heavy.code),
        LABELS.backgroundUserPrefix,
        profile.backgroundUsers,
        LABELS.noiseUserPrefix,
        LABELS.account(noise.code),
        LABELS.userPlan(noise.code),
        profile.noiseUsers,
      ],
    },
  ];

  const heavyMonths = perMonth(profile.heavyUserDecisions);
  const background = profile.backgroundUsers * profile.backgroundDecisionsPerUser;
  // S2 spreads background rows evenly; S3 puts them all in the oldest month, after the heavy user.
  const backgroundMonths =
    shape === "s2"
      ? perMonth(background)
      : SEED_MONTHS.map((_m, index) => (index === 0 ? background : 0));
  const noiseMonths = perMonth(profile.noiseDecisions);

  SEED_MONTHS.forEach((month, index) => {
    statements.push({
      label: `decisions h ${month}`,
      sql: DECISIONS_SQL,
      params: [
        LABELS.account(heavy.code),
        month,
        heavy.code,
        LABELS.heavyUser,
        heavyMonths.at(index) ?? 0,
        LABELS.backgroundUserPrefix,
        profile.backgroundUsers,
        backgroundMonths.at(index) ?? 0,
        shape === "s3",
        profile.rejectEvery,
        REJECTED_UNITS,
      ],
    });
    statements.push({
      label: `decisions n ${month}`,
      sql: DECISIONS_SQL,
      params: [
        LABELS.account(noise.code),
        month,
        noise.code,
        null,
        0,
        LABELS.noiseUserPrefix,
        profile.noiseUsers,
        noiseMonths.at(index) ?? 0,
        false,
        profile.rejectEvery,
        REJECTED_UNITS,
      ],
    });
  });

  statements.push(
    { label: "account counters", sql: COUNTERS_SQL.account, params: [] },
    { label: "user counters", sql: COUNTERS_SQL.user, params: [] },
  );
  return statements;
}
