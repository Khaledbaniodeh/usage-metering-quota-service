-- Baseline schema of the Usage Metering and Quota Service.
-- See docs/architecture.md for the approved data model this migration implements.
--
-- Conventions:
--   * Every business timestamp is supplied by the application's single UTC clock, so business
--     tables have no DEFAULT now(). Only schema_migrations (managed by the runner) uses one.
--   * Units and plan limits are integers bounded to 1..1,000,000,000; usage counters are BIGINT
--     and never negative.
--   * Months are stored as the first day of the UTC calendar month.

-- Level at which a plan applies and at which a quota rule can block a request.
CREATE TYPE quota_level AS ENUM ('ACCOUNT', 'USER');

-- Rule that can block a consume request.
CREATE TYPE quota_rule AS ENUM ('MAX_UNITS_PER_REQUEST', 'MONTHLY_ALLOWANCE');

CREATE TABLE plans (
  id uuid PRIMARY KEY,
  -- Stable code for predefined plans (starter, pro, basic, premium); NULL for custom plans.
  code text UNIQUE,
  -- Owning account for custom plans; NULL for predefined plans. Foreign key added below.
  owner_account_id uuid,
  scope quota_level NOT NULL,
  name text NOT NULL,
  monthly_allowance integer NOT NULL,
  max_units_per_request integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Referenced by accounts and users so that an assignment carries the plan's scope.
  CONSTRAINT plans_id_scope_key UNIQUE (id, scope),
  CONSTRAINT plans_predefined_xor_custom CHECK ((code IS NULL) <> (owner_account_id IS NULL)),
  CONSTRAINT plans_code_format CHECK (code IS NULL OR code ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT plans_name_format CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT plans_monthly_allowance_range CHECK (monthly_allowance BETWEEN 1 AND 1000000000),
  CONSTRAINT plans_max_units_per_request_range CHECK (max_units_per_request BETWEEN 1 AND 1000000000),
  CONSTRAINT plans_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  -- SHA-256 digest of the API key; the key itself is never stored.
  api_key_hash bytea NOT NULL,
  plan_id uuid NOT NULL,
  -- Fixed value that lets the composite foreign key below accept only ACCOUNT-scoped plans.
  plan_scope quota_level NOT NULL DEFAULT 'ACCOUNT',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT accounts_api_key_hash_key UNIQUE (api_key_hash),
  CONSTRAINT accounts_api_key_hash_length CHECK (octet_length(api_key_hash) = 32),
  CONSTRAINT accounts_name_format CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT accounts_plan_scope_is_account CHECK (plan_scope = 'ACCOUNT'),
  CONSTRAINT accounts_plan_fkey FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope),
  CONSTRAINT accounts_updated_not_before_created CHECK (updated_at >= created_at)
);

ALTER TABLE plans
  ADD CONSTRAINT plans_owner_account_fkey
  FOREIGN KEY (owner_account_id) REFERENCES accounts (id);

-- Lists an account's custom plans.
CREATE INDEX plans_owner_account_id_idx ON plans (owner_account_id) WHERE owner_account_id IS NOT NULL;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  -- Insertion order, used for deterministic keyset pagination.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  name text NOT NULL,
  plan_id uuid NOT NULL,
  -- Fixed value that lets the composite foreign key below accept only USER-scoped plans.
  plan_scope quota_level NOT NULL DEFAULT 'USER',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Referenced by usage counters and decisions so they can never cross accounts.
  CONSTRAINT users_account_id_id_key UNIQUE (account_id, id),
  -- Keyset pagination of an account's users (seq DESC).
  CONSTRAINT users_account_id_seq_key UNIQUE (account_id, seq),
  CONSTRAINT users_name_format CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT users_plan_scope_is_user CHECK (plan_scope = 'USER'),
  CONSTRAINT users_plan_fkey FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope),
  CONSTRAINT users_updated_not_before_created CHECK (updated_at >= created_at)
);

-- Authoritative account usage per UTC month.
CREATE TABLE account_monthly_usage (
  account_id uuid NOT NULL REFERENCES accounts (id),
  month date NOT NULL,
  used bigint NOT NULL DEFAULT 0,
  CONSTRAINT account_monthly_usage_pkey PRIMARY KEY (account_id, month),
  CONSTRAINT account_monthly_usage_month_is_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT account_monthly_usage_used_not_negative CHECK (used >= 0)
);

-- Authoritative user usage per UTC month.
CREATE TABLE user_monthly_usage (
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  month date NOT NULL,
  used bigint NOT NULL DEFAULT 0,
  CONSTRAINT user_monthly_usage_pkey PRIMARY KEY (user_id, month),
  CONSTRAINT user_monthly_usage_user_fkey FOREIGN KEY (account_id, user_id)
    REFERENCES users (account_id, id),
  CONSTRAINT user_monthly_usage_month_is_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT user_monthly_usage_used_not_negative CHECK (used >= 0)
);

-- Per-user usage of one account for one month.
CREATE INDEX user_monthly_usage_account_month_idx ON user_monthly_usage (account_id, month);

-- Immutable decision history and idempotency record. Each row snapshots everything needed to
-- explain the decision later, even after plans are renamed, updated or switched.
CREATE TABLE consume_decisions (
  id uuid PRIMARY KEY,
  -- Insertion order, used for deterministic keyset pagination of history.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  request_id text NOT NULL,
  units integer NOT NULL,
  accepted boolean NOT NULL,
  blocking_rule quota_rule,
  blocking_level quota_level,
  account_plan_id uuid NOT NULL REFERENCES plans (id),
  account_plan_name text NOT NULL,
  account_monthly_allowance integer NOT NULL,
  account_max_units_per_request integer NOT NULL,
  user_plan_id uuid NOT NULL REFERENCES plans (id),
  user_plan_name text NOT NULL,
  user_monthly_allowance integer NOT NULL,
  user_max_units_per_request integer NOT NULL,
  account_used_before bigint NOT NULL,
  user_used_before bigint NOT NULL,
  month date NOT NULL,
  processed_at timestamptz NOT NULL,
  CONSTRAINT consume_decisions_account_id_request_id_key UNIQUE (account_id, request_id),
  CONSTRAINT consume_decisions_account_id_seq_key UNIQUE (account_id, seq),
  CONSTRAINT consume_decisions_user_fkey FOREIGN KEY (account_id, user_id)
    REFERENCES users (account_id, id),
  CONSTRAINT consume_decisions_request_id_format CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT consume_decisions_units_range CHECK (units BETWEEN 1 AND 1000000000),
  CONSTRAINT consume_decisions_plan_names_format CHECK (
    char_length(account_plan_name) BETWEEN 1 AND 100
    AND char_length(user_plan_name) BETWEEN 1 AND 100
  ),
  CONSTRAINT consume_decisions_limits_range CHECK (
    account_monthly_allowance BETWEEN 1 AND 1000000000
    AND account_max_units_per_request BETWEEN 1 AND 1000000000
    AND user_monthly_allowance BETWEEN 1 AND 1000000000
    AND user_max_units_per_request BETWEEN 1 AND 1000000000
  ),
  CONSTRAINT consume_decisions_used_before_not_negative CHECK (
    account_used_before >= 0 AND user_used_before >= 0
  ),
  CONSTRAINT consume_decisions_month_is_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  -- The month is always the UTC calendar month of processed_at.
  CONSTRAINT consume_decisions_month_matches_processed_at CHECK (
    month = date_trunc('month', processed_at AT TIME ZONE 'UTC')::date
  ),
  -- A blocking rule and level are present exactly when the request was rejected.
  CONSTRAINT consume_decisions_blocking_reason_presence CHECK (
    (accepted AND blocking_rule IS NULL AND blocking_level IS NULL)
    OR (NOT accepted AND blocking_rule IS NOT NULL AND blocking_level IS NOT NULL)
  ),
  -- Every accepted request satisfied all four limits recorded in its own snapshot.
  CONSTRAINT consume_decisions_accepted_within_limits CHECK (
    NOT accepted
    OR (
      units <= account_max_units_per_request
      AND units <= user_max_units_per_request
      AND account_used_before + units <= account_monthly_allowance
      AND user_used_before + units <= user_monthly_allowance
    )
  ),
  -- Every rejection names a rule that the snapshot actually violates.
  CONSTRAINT consume_decisions_rejection_justified CHECK (
    accepted
    OR (blocking_rule = 'MAX_UNITS_PER_REQUEST' AND blocking_level = 'USER'
        AND units > user_max_units_per_request)
    OR (blocking_rule = 'MAX_UNITS_PER_REQUEST' AND blocking_level = 'ACCOUNT'
        AND units > account_max_units_per_request)
    OR (blocking_rule = 'MONTHLY_ALLOWANCE' AND blocking_level = 'USER'
        AND user_used_before + units > user_monthly_allowance)
    OR (blocking_rule = 'MONTHLY_ALLOWANCE' AND blocking_level = 'ACCOUNT'
        AND account_used_before + units > account_monthly_allowance)
  )
);

-- History filtered by user, and by month (newest first via seq DESC).
CREATE INDEX consume_decisions_account_user_seq_idx ON consume_decisions (account_id, user_id, seq);
CREATE INDEX consume_decisions_account_month_seq_idx ON consume_decisions (account_id, month, seq);

-- Plans: predefined plans are read-only; identity, scope, ownership and creation time never
-- change; plans are never deleted.
CREATE FUNCTION plans_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plans cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.code IS NOT NULL THEN
    RAISE EXCEPTION 'predefined plan "%" is read-only', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.scope <> OLD.scope
     OR NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan id, scope, owner, code and created_at are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plans_immutability
  BEFORE UPDATE OR DELETE ON plans
  FOR EACH ROW EXECUTE FUNCTION plans_enforce_immutability();

-- Decision history is append-only.
CREATE FUNCTION consume_decisions_reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consume decisions are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER consume_decisions_append_only
  BEFORE UPDATE OR DELETE ON consume_decisions
  FOR EACH ROW EXECUTE FUNCTION consume_decisions_reject_modification();
