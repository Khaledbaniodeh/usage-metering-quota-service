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

## Consume transaction

1. Authenticate and validate `userId`, `units` (integer, 1 to 1,000,000,000) and `requestId`.
2. Fast path, outside a transaction: an existing decision for `(account, requestId)` with the same
   payload is returned unchanged; a different payload returns `409 IDEMPOTENCY_CONFLICT`.
3. Capture the time once from the injected clock and derive the UTC month.
4. Begin a READ COMMITTED transaction with a lock timeout.
5. Read the user (scoped to the account), the account and both assigned plans in one statement.
   An unknown or foreign user returns `404` and nothing is recorded.
6. Create missing monthly counter rows, then lock the account counter, then the user counter.
7. Re-check idempotency under the lock.
8. Evaluate the limits in a fixed order: user per-request, account per-request, user monthly,
   account monthly. The first failing rule is reported with its level.
9. Increment both counters only when accepted; insert the immutable decision record; commit.

Every decision returns HTTP 200 with `accepted: true` or `accepted: false`. The response is built
only from the stored decision record, so a retry receives exactly the same body.

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
- **Bounded waiting:** a lock timeout returns `503 BUSY_RETRY` with `Retry-After`; retrying with
  the same `requestId` is safe.
- **Clock:** one injected application clock, UTC, millisecond precision, captured once per request.

## Phased implementation plan

| Phase | Scope                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0     | Project scaffolding and quality gates                                                                                         |
| 1     | Configuration, logging, database pool, migration runner, schema and predefined plans, health endpoint, Dockerfile and Compose |
| 2     | Account creation, API keys, authentication, error catalogue, isolation test harness                                           |
| 3     | Plans and users, plan assignment and switching                                                                                |
| 4     | Consume engine, idempotency, concurrency tests                                                                                |
| 5     | Usage and history endpoints, cursor pagination                                                                                |
| 6     | Example client and end-to-end Compose verification in CI                                                                      |
| 7     | Load testing, invariant checks, bottleneck analysis                                                                           |
| 8     | Final documentation and requirements traceability review                                                                      |

## Deferred optional features

- Interactive example-client subcommands.
- Moving the locked critical section into a single SQL round trip, only if load tests show the
  lock-hold time dominates.
- Fully declarative custom-plan ownership through a sentinel owner key.
- A trigger that makes plan scope immutable even for unreferenced plans.
- Reporting every violated rule instead of the first one.
- UUIDv7 identifiers and CI badges.

Out of scope: billing, payments, refunds, multiple resource types, end-user login, role-based
permissions, key rotation, deletion, rate limiting, caching, multiple service instances and other
distributed infrastructure.
