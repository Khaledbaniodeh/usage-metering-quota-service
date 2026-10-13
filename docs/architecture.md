# Architecture

This document records the approved architecture of the Usage Metering and Quota Service. It
describes the target design; the [README](../README.md) states which parts are implemented so far.

## Purpose

Applications (accounts) call the service before performing a metered action on behalf of one of
their users. The service checks the account's shared plan and the user's individual plan, records
the decision, and counts the usage only when the request is accepted. Plans can be predefined or
created by the account, and plan changes take effect without redeploying.

Two rule types apply at both levels:

- **Monthly allowance**: total units available during a UTC calendar month.
- **Maximum units per request**: the largest amount a single request may consume.

A request is accepted only if all four checks pass. A rejection consumes nothing.

## Main components

| Component            | Responsibility                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Configuration        | Typed, fail-fast environment parsing with bounds; no defaults for secrets                                         |
| Composition root     | Builds every dependency explicitly; startup runs migrations, then listens; graceful shutdown with a deadline      |
| HTTP layer           | Fastify routes, TypeBox request/response schemas, generated OpenAPI, error-to-status mapping, log redaction       |
| Authentication hook  | Reads `X-API-Key`, checks its format, hashes it with SHA-256 and resolves the calling account                     |
| Application services | Accounts, plans, users, consumption, usage and history; own transaction boundaries                                |
| Domain rules (pure)  | UTC month calculation, remaining-allowance clamp, ordered rule evaluation, decision response building             |
| Repositories         | Explicit parameterized SQL, always scoped by the authenticated account                                            |
| Database support     | Connection pool with statement and lock timeouts, pool error listener, transaction helper, migration runner       |
| Migration runner     | Ordered SQL files, PostgreSQL advisory lock, one transaction per migration, checksum verification                 |
| Example client       | Deterministic command-line scenario that demonstrates every required behavior and fails on any unexpected outcome |
| Load-test kit        | k6 constant-arrival-rate scenarios plus a database invariant checker run after every load test                    |

## Dependency direction

```
HTTP routes → application services → domain rules (pure)
                                   → repositories → PostgreSQL
```

The domain layer has no dependencies. Only the composition root constructs objects; modules have
no import-time side effects. The example client talks to the service over HTTP only.

## Source layout

Directories are created when a phase adds real code to them. As of Phase 4:

```
src/
  main.ts              process entry: configuration, logger, startup, signals, shutdown deadline
  app/                 Fastify construction (build-app), production wiring (dependencies), error
                       contract, OpenAPI, server lifecycle
  config/              the single configuration parser (every environment variable is read here)
  db/                  pool, type conversions, migration runner and CLI, readiness check,
                       PostgreSQL error classification, transaction helper
    migrations/        forward-only SQL files (NNNN_name.sql), copied into dist/ by the build
  modules/
    accounts/          account schemas, routes, service and repository; account plan switching
    auth/              API-key primitives and the X-API-Key authentication hook
    consumption/       pure quota rules (domain), consume schemas, routes, service and
                       repository
    health/            liveness and readiness routes; owns the readiness port
    plans/             plan schemas, routes, service and repository; the shared plan summary
                       columns and the plan-assignment outcome used by accounts and users
    users/             user schemas, routes, service and repository; user plan switching
  shared/              cross-cutting pieces with one clear owner each: clock, logger, error
                       catalogue, HTTP error contract, display-name schema
tests/
  unit/                no database; mirrors src/
  integration/         real PostgreSQL; mirrors src/
  helpers/             test database lifecycle and guard, application builder, account-isolation
                       harness, fixtures, loggers
```

Feature code (plans, users, usage, consumption) lives in `src/modules/<feature>/`, each module
containing its schemas, routes, service and repository. SQL migrations stay in `src/db/migrations/`,
separate from the runtime queries in module repositories.

## Data model summary

| Table                   | Purpose and key constraints                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans`                 | Predefined (stable `code`, no owner) or custom (owned by one account). Scope `ACCOUNT` or `USER`, never changed. Limits are integers from 1 to 1,000,000,000. Unique `(id, scope)` so assignments can reference plan and scope.  |
| `accounts`              | Name, SHA-256 API-key hash (unique), assigned plan. A fixed `plan_scope = 'ACCOUNT'` column plus a composite foreign key guarantees only account plans are assigned.                                                             |
| `users`                 | Belongs to one account; unique `(account_id, id)`. A fixed `plan_scope = 'USER'` column plus a composite foreign key guarantees only user plans are assigned.                                                                    |
| `account_monthly_usage` | Authoritative account counter per UTC month; `used` never negative.                                                                                                                                                              |
| `user_monthly_usage`    | Authoritative user counter per UTC month; references `(account_id, user_id)` so usage cannot cross accounts.                                                                                                                     |
| `consume_decisions`     | Immutable history and idempotency record. Unique `(account_id, request_id)`. Snapshots both plan IDs, plan names, all four limits and both "used before" values. A row check proves every accepted row satisfied its own limits. |

Predefined plans are inserted by a migration:

| Plan    | Scope   | Monthly allowance | Max units per request |
| ------- | ------- | ----------------: | --------------------: |
| Starter | ACCOUNT |            10,000 |                   100 |
| Pro     | ACCOUNT |           100,000 |                 1,000 |
| Basic   | USER    |             1,000 |                    20 |
| Premium | USER    |            10,000 |                   100 |

New accounts receive Starter and new users receive Basic. Custom-plan ownership ("predefined or
owned by this account") is enforced atomically by the assignment statement itself.

Database-level protections implemented in Phase 1 (`src/db/migrations/0001_baseline_schema.sql`):

- **Plans:** a trigger keeps predefined plans read-only, freezes every plan's id, scope, owner,
  code and creation time, and forbids deleting plans. (This also makes scope immutable for plans
  that are not yet assigned, which was previously listed as a deferred option.)
- **Decision history:** a trigger rejects every `UPDATE` and `DELETE` on `consume_decisions`.
  Besides the accepted-within-limits check, a second check requires every rejection to name a rule
  that its own snapshot violates, and the stored month must be the UTC month of `processed_at`.
- **Timestamps:** every `*_at` column is `timestamptz`. Business timestamps have no database
  default; they come from the application's single UTC clock. Only `schema_migrations.applied_at`
  defaults to `now()`.
- **Type conversions:** the pool converts `BIGINT` to a JavaScript number and fails on values
  beyond the safe-integer range, and keeps `DATE` values as `YYYY-MM-DD` strings, so a month is
  never shifted by the host time zone.

The project targets PostgreSQL 16 (Compose and CI use `postgres:16.15-alpine`).

## Consume transaction

Implemented in `src/modules/consumption/` (Phase 4). Route → `consume.service.ts` (workflow and
transaction boundary) → `consume.repository.ts` (SQL) → PostgreSQL; the rules live in the pure
`consume.domain.ts`.

1. Authenticate and validate `userId` (UUID), `units` (JSON integer, 1 to 1,000,000,000) and
   `requestId` (1-128 of `[A-Za-z0-9._:-]`). Unknown fields are rejected; nothing is coerced.
   The `userId` is compared in lower case.
2. **Fast path**, outside a transaction: look up `(account, requestId)`. A stored decision with
   the same `userId` and `units` is returned unchanged; a different payload is
   `409 IDEMPOTENCY_CONFLICT`. No clock read happens on this path.
3. Only for a new request: read the injected clock once and derive the UTC month (first day,
   `YYYY-MM-01`).
4. `withTransaction` (`src/db/transaction.ts`): a dedicated pooled connection,
   `BEGIN ISOLATION LEVEL READ COMMITTED`, then `set_config('lock_timeout', …, true)` from
   `DB_LOCK_TIMEOUT_MS`.
5. One statement reads the user (filtered by account and ID), the account and both assigned plans,
   with no row locks. No row means an unknown or foreign user: `404 User not found`, and the
   transaction rolls back with nothing written.
6. `INSERT … ON CONFLICT DO NOTHING` creates missing counter rows (account, then user). Then
   `SELECT … FOR UPDATE` locks the account counter, then the user counter.
7. Re-check `(account, requestId)` under the account-counter lock. If a decision appeared, the
   transaction rolls back and the request is answered as in step 2.
8. Evaluate the four limits (`evaluateQuota`) on the plan snapshot and the freshly locked counter
   values: user per-request, account per-request, user monthly, account monthly. The first
   failure is reported.
9. If accepted, increment the account counter, then the user counter. Insert the immutable
   decision (plan IDs, names, four limits, both "used before" values, month, `processed_at`) and
   commit.
10. The response is `toDecisionResponse(stored row)`: `used = usedBefore + (accepted ? units : 0)`,
    `remaining = max(0, allowance − used)`. Original responses and replays share this one
    function and read nothing else.

Failure handling:

- Any error rolls back the whole transaction, including counter increments. A connection whose
  `ROLLBACK` fails is destroyed instead of being reused.
- **Backstop:** a unique violation of exactly `consume_decisions_account_id_request_id_key`
  means a duplicate committed first. Normally the account lock prevents this; it is reachable
  only for duplicates in different UTC months, which lock different counter rows. The loser has
  already rolled back; the winning decision is read and replayed, or answered with 409.
- A lock timeout (SQLSTATE `55P03` only) becomes `503 BUSY_RETRY` with `Retry-After: 1`, with
  nothing written. Statement timeouts, deadlocks and other errors stay generic 500s.

Every decision returns HTTP 200 with `accepted: true` or `accepted: false`.

## Concurrency and idempotency strategy

- **Consistent limits:** under READ COMMITTED a single statement sees one committed snapshot, so
  both assignments and both plan versions come from the same instant; mixed old and new limits
  are impossible. Updates committed before the request began are always visible.
- **Fresh counters:** row locks return the latest committed counter values, so concurrent
  requests can never exceed an allowance or lose an increment.
- **No deadlocks:** only consume transactions write counters, each touches one account row and
  one user row, always in the order account then user.
- **No blocking of plan changes:** consumes never lock plan, account or user rows; plan edits and
  switches therefore never wait behind consume traffic.
- **Idempotency:** unique `(account_id, request_id)`; fast-path lookup; authoritative re-check
  under the account lock; a unique-violation backstop (needed only for duplicates that straddle a
  month boundary) rolls back and replays the winning decision.
- **Bounded waiting:** a lock timeout returns `503 BUSY_RETRY` with `Retry-After: 1`; retrying
  with the same `requestId` is safe.
- **How concurrency is tested:** deterministically, without sleeps.
  - A test connection holds the account counter's row lock.
  - The racing requests are sent.
  - The test waits until `pg_stat_activity` shows the expected number of the service's backends
    waiting on a lock, then releases.
  - The month-boundary backstop and injected failures (at the decision insert or `COMMIT`) use
    test-only interception of `pg.Client.prototype.query`.
  - Every wait has a deadline.
  - After the files run, a direct-SQL checker (`tests/helpers/quota-invariants.ts`) verifies the
    stored data:
    - counters equal their accepted decisions;
    - each decision's "used before" equals the earlier accepted units in its month (serialized
      decisions);
    - every rejection names the first failing rule;
    - there are no duplicates, cross-tenant rows or negative usage.
  - Mutation checks confirm the tests catch regressions: without the counter row locks, 59 of 60
    racing requests are accepted instead of 50.

- **Clock:** one injected application clock, UTC, millisecond precision, captured once per request.

## Accounts, API keys and authentication

- **Account creation** (`POST /v1/accounts`, public): the name is validated by a strict schema
  (1-100 characters, single line, no control characters, already trimmed, no unknown fields;
  request validation never coerces types). The service reads the clock once, generates the
  account UUID and inserts the account in one statement that resolves the predefined plan by its
  code (`starter`) and assigns it atomically.
- **API keys:** `umqs_` followed by 32 bytes from `node:crypto` as 43 unpadded base64url
  characters. Only the SHA-256 digest of the whole key is stored (`accounts.api_key_hash`, unique).
  A 256-bit random key cannot be guessed or precomputed, so a fast deterministic hash is enough and
  allows an indexed lookup; salts or slow hashes would add cost without adding safety. The raw key
  appears once, in the 201 response (sent with `Cache-Control: no-store`). A digest collision is
  retried with a fresh key up to three times. Key rotation is out of scope.
- **Authentication:** an `onRequest` hook on protected routes reads `X-API-Key` from the raw header
  list (a repeated header is rejected rather than joined), uses it unmodified, checks its format,
  hashes it and resolves the account by digest. The account is never taken from client-supplied
  IDs. Missing, repeated, malformed and unknown keys receive the identical `401 UNAUTHORIZED`
  response, and malformed keys never reach the database. Routes read the typed authenticated
  account through `requireAuthenticatedAccount`. `GET /v1/account` is the first protected route.
- **Error catalogue** (`src/shared/error-catalogue.ts`): every public code is defined once with its
  HTTP status and default message, and the compiler rejects a catalogue that misses or adds a code.
  Routes declare their error responses from the catalogue, so OpenAPI lists the exact codes.

## Plans, users and plan assignment

- **Tenant boundary:** every query takes the authenticated account ID from the authentication hook
  and filters on it inside the statement that reads or changes data; no client-supplied field can
  name an account. Visible plans are `owner_account_id IS NULL OR owner_account_id = <account>`.
  Unknown resources and other accounts' resources produce byte-identical 404 responses.
- **Plans:** `GET /v1/plans` returns the predefined plans, then the account's custom plans, each
  group in creation order, in one query. `POST /v1/plans` stores the authenticated account as
  owner and `code` as NULL. `PATCH /v1/plans/{planId}` is one statement: a CTE classifies the plan
  as visible or not and predefined or not, and the `UPDATE` itself is restricted to
  `owner_account_id = <account>`, so it can never touch a predefined or foreign plan; the schema's
  plan trigger additionally keeps predefined plans read-only and scope, owner and code immutable.
  Limits are JSON integers from 1 to 1,000,000,000, validated without type coercion, and match the
  database CHECK constraints. Account, user and plan names share one display-name schema
  (`src/shared/display-name.ts`).
- **Users:** creation resolves the predefined `basic` plan by code and inserts the user with it in
  one statement. The list is one `users JOIN plans` query ordered by `seq` (no N+1; a test counts
  the queries for 1 and 5 users). Lookups filter on `account_id` and `id` together.
- **Plan switching** (`PUT /v1/account/plan`, `PUT /v1/users/{userId}/plan`): one statement per
  request. CTEs check that the target exists in the account and that the plan is visible; the
  `UPDATE ... FROM plan` requires the target's account and the plan's scope in its own `WHERE`
  clause, so ownership and scope are enforced by the statement that writes, not by an earlier
  read. The same statement returns diagnostics for the error order: unknown or foreign user (404),
  unknown or foreign plan (404), wrong scope (409 `PLAN_SCOPE_MISMATCH`). The composite
  `(plan_id, plan_scope)` foreign keys also reject a wrong-scope plan at the database level.
- **No-op reassignment:** `updated_at = CASE WHEN plan_id = <new plan> THEN updated_at ELSE now END`.
  Assigning the current plan returns 200 with the unchanged row. Because the `CASE` is evaluated
  on the locked, latest row version, racing identical switches change the plan once and keep one
  `updatedAt` (covered by a concurrency test).
- **Clock:** each mutation reads the injected clock once and uses that value for every timestamp
  it writes.

## Startup, health and shutdown

- **Startup** (`src/app/server.ts`): load the migration files, migrate on a dedicated connection,
  open the pool, build the application, listen on `0.0.0.0`. A migration or database failure is
  fatal: whatever was created is closed and the process exits with code 1.
- **Migrations** (`src/db/migrator.ts`, shared by startup and `npm run db:migrate`): files are
  applied in byte order, each in one transaction together with its `schema_migrations` row (name,
  SHA-256 checksum of the LF-normalized file, applied time). A session-level advisory lock with a
  bounded wait serializes concurrent instances. Before applying anything the runner requires the
  applied migrations to be exactly the first files with identical checksums, so an edited, removed
  or reordered migration aborts the run.
- **Health:** `GET /health/live` never touches the database. `GET /health/ready` returns 200 only
  when a small read of `schema_migrations` through the pool succeeds and matches the shipped
  migrations exactly; otherwise 503 with the standard error body. Successful probes are not
  request-logged.
- **Shutdown** (`src/main.ts`): on SIGINT or SIGTERM the server stops accepting connections,
  waits for in-flight requests, then closes the pool. A deadline (`SHUTDOWN_TIMEOUT_MS`) forces
  exit code 1 if shutdown hangs.

## Phased implementation plan

| Phase | Scope                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Project scaffolding and quality gates                                                                                          |
| 1     | Configuration, logging, database pool, migration runner, schema and predefined plans, health endpoints, Dockerfile and Compose |
| 2     | Account creation, API keys, authentication, error catalogue, isolation test harness                                            |
| 3     | Plans and users, plan assignment and switching                                                                                 |
| 4     | Consume engine, idempotency, concurrency tests                                                                                 |
| 5     | Usage and history endpoints, cursor pagination                                                                                 |
| 6     | Example client and end-to-end Compose verification in CI                                                                       |
| 7     | Load testing, invariant checks, bottleneck analysis                                                                            |
| 8     | Final documentation and requirements traceability review                                                                       |

## Deferred optional features

- Interactive example-client subcommands.
- Moving the locked critical section into a single SQL round trip, only if load tests show the
  lock-hold time dominates.
- Fully declarative custom-plan ownership through a sentinel owner key.
- Reporting every violated rule instead of the first one.
- UUIDv7 identifiers and CI badges.

Out of scope: billing, payments, refunds, multiple resource types, end-user login, role-based
permissions, key rotation, deletion, rate limiting, caching, multiple service instances and other
distributed infrastructure.
