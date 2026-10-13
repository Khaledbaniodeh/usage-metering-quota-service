-- The four approved predefined plans. Identifiers and timestamps are fixed so that every
-- environment contains byte-identical records. Predefined plans are read-only (enforced by the
-- plans_immutability trigger); changing them requires a new migration.
INSERT INTO plans (
  id, code, owner_account_id, scope, name, monthly_allowance, max_units_per_request,
  created_at, updated_at
)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'starter', NULL, 'ACCOUNT', 'Starter', 10000, 100,
   '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000002', 'pro', NULL, 'ACCOUNT', 'Pro', 100000, 1000,
   '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('b0000000-0000-4000-8000-000000000001', 'basic', NULL, 'USER', 'Basic', 1000, 20,
   '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z'),
  ('b0000000-0000-4000-8000-000000000002', 'premium', NULL, 'USER', 'Premium', 10000, 100,
   '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
