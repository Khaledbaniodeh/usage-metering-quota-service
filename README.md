# Usage Metering and Quota Service

A backend service that other applications call to record usage and decide whether their users may
perform an action. Each account has a shared monthly allowance and each of its users has an
individual allowance; a request is accepted only when every applicable account and user rule allows
it.

## Status

**Implementation Phase 4: the consumption engine.**

Implemented so far:

- Fastify 5 service with strictly validated configuration and request bodies, structured JSON
  logging with credential redaction, and graceful startup and shutdown.
- PostgreSQL schema for plans, accounts, users, monthly usage counters and the immutable decision
  history, created by a forward-only migration runner, plus the four predefined plans.
- Account creation with a one-time API key, X-API-Key authentication and the authenticated
  account endpoint.
- Plan listing, custom plans (create and update) and account-scoped users, with plan switching
  for the account and each of its users under strict tenant isolation.
- Atomic, idempotent consumption: `POST /v1/consume` checks the four account and user limits,
  counts accepted units in monthly counters and records every decision immutably, with safe
  retries, bounded lock waiting and proven behavior under concurrent requests.
- One catalogue of stable error codes behind a single JSON error shape.
- Liveness and readiness endpoints and generated OpenAPI documentation.
- Production Docker image and a Docker Compose stack (service + PostgreSQL).
- Unit tests, and integration tests against a real PostgreSQL database, including an
  account-isolation harness.

**Not implemented yet:** the usage and history APIs, the example client and load tests. They arrive in later, separately verified phases described in
[docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 22 (see [.nvmrc](.nvmrc); minimum `22.13.0`) and npm
- Docker with Docker Compose v2, for the containerized stack and the local test database
- PostgreSQL 16 (provided by Docker Compose)

## Environment setup

```bash
npm ci
cp .env.example .env
```

Every variable is documented in [.env.example](.env.example); the values there are
**local development only** examples. `.env` is git-ignored and must never be committed. The service
reads all configuration through [src/config/config.ts](src/config/config.ts) and refuses to start
when a value is missing or invalid; only `DATABASE_URL` is required.

## Running with Docker Compose

```bash
docker compose up --build        # PostgreSQL + service; migrations run before the service listens
docker compose down              # stop and remove containers; the database volume is kept
docker compose down --volumes    # also delete the database volume (destroys local data)
```

The service is published on `http://127.0.0.1:8080` and PostgreSQL on `127.0.0.1:5432` (loopback
only; change with `API_HOST_PORT` and `POSTGRES_HOST_PORT`). The Compose credentials are
development-only defaults that can be overridden through environment variables or `.env`.

## Running locally with npm

Start only the database, then run the service from source (reads `.env`):

```bash
docker compose up --detach postgres
npm run db:migrate   # optional: the service also migrates on startup
npm run dev
```

| Command                    | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`              | Run the service from source with auto-restart (loads `.env` if present) |
| `npm run build`            | Compile `src/` to `dist/` and copy the SQL migrations                   |
| `npm start`                | Run the compiled service (`dist/main.js`)                               |
| `npm run db:migrate`       | Apply pending migrations and exit (same code as startup)                |
| `npm test`                 | All unit and integration tests (needs PostgreSQL, see below)            |
| `npm run test:unit`        | Unit tests only (no database needed)                                    |
| `npm run test:integration` | Integration tests against PostgreSQL                                    |
| `npm run test:coverage`    | All tests with V8 coverage and the enforced 80% thresholds              |
| `npm run format:check`     | Verify Prettier formatting (`npm run format` applies it)                |
| `npm run lint`             | ESLint (type-aware, security rules) with zero warnings allowed          |
| `npm run typecheck`        | TypeScript type-check of source, tests and tooling config               |
| `npm run check`            | All local quality gates: format, lint, type-check, tests, build         |

## Database migrations

Migrations are plain SQL files in [src/db/migrations](src/db/migrations), named `NNNN_name.sql`
and applied in order. They are **forward-only and immutable once applied**: each applied file's
SHA-256 checksum is stored in `schema_migrations`, and the service refuses to start if an applied
migration was edited, removed or reordered. Change the schema by adding a new file.

Each migration runs in its own transaction, and a PostgreSQL advisory lock ensures only one
instance migrates at a time. The same runner is used by `npm run db:migrate` and by service
startup; inside the container you can also run `docker compose run --rm api node dist/db/migrate-cli.js`.

## Accounts and API keys

### Create an account

`POST /v1/accounts` is public. The name must be 1-100 characters on a single line, without control
characters or leading or trailing whitespace; names do not need to be unique. Unknown fields are
rejected.

```bash
curl -s -X POST http://127.0.0.1:8080/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme"}'
```

Response `201 Created` (values shortened):

```json
{
  "id": "<account-id>",
  "name": "Acme",
  "createdAt": "2026-10-13T09:30:15.123Z",
  "updatedAt": "2026-10-13T09:30:15.123Z",
  "plan": {
    "id": "a0000000-0000-4000-8000-000000000001",
    "code": "starter",
    "name": "Starter",
    "scope": "ACCOUNT",
    "monthlyAllowance": 10000,
    "maxUnitsPerRequest": 100
  },
  "apiKey": "umqs_<43 characters>"
}
```

- **The API key is shown only once.** Store it securely: the response is sent with
  `Cache-Control: no-store`, and the service keeps only the SHA-256 digest of the key, so it can
  never show the key again. Lost keys cannot be recovered; key rotation is out of scope.
- **Every new account starts on the predefined Starter plan** (10,000 units per month, at most 100
  per request).
- Keys have the form `umqs_` followed by 43 base64url characters (32 random bytes).

### Authenticate

Protected endpoints require the key in the `X-API-Key` header, exactly once and unmodified. The
example below reads it from an environment variable instead of pasting it into the command:

```bash
export UMQS_API_KEY='<your-api-key>'
curl -s http://127.0.0.1:8080/v1/account -H "X-API-Key: $UMQS_API_KEY"
```

`GET /v1/account` returns the account that owns the key, with its assigned plan (the creation
response without `apiKey`). A missing, repeated, malformed or unknown key always receives the same
response, so callers cannot tell which check failed:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "A valid API key is required" } }
```

### Error responses

Every error uses the shape `{ "error": { "code": "...", "message": "..." } }`. Codes are stable and
defined once in [src/shared/error-catalogue.ts](src/shared/error-catalogue.ts):

| Code                                                                        | HTTP     | Meaning                                                |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| `VALIDATION_ERROR`, `BAD_REQUEST`                                           | 400      | The request is invalid or could not be parsed          |
| `UNAUTHORIZED`                                                              | 401      | A valid API key is required                            |
| `NOT_FOUND`                                                                 | 404      | The route or resource does not exist                   |
| `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PLAN_READ_ONLY`, `PLAN_SCOPE_MISMATCH` | 409      | The request conflicts with current state               |
| `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`                               | 413, 415 | The body is too large or not JSON                      |
| `BUSY_RETRY`, `SERVICE_UNAVAILABLE`                                         | 503      | Retry later (`BUSY_RETRY`) or the service is not ready |
| `INTERNAL_ERROR`                                                            | 500      | Unexpected failure; no internal details are returned   |

## Plans and users

All endpoints below require `X-API-Key` and act only on the authenticated account. An unknown ID
and an ID that belongs to another account always receive the same response, so callers cannot
discover other accounts' resources.

| Endpoint                      | Purpose                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `GET /v1/plans`               | Predefined plans, then the account's own custom plans (`?scope=` filters) |
| `POST /v1/plans`              | Create a custom plan owned by the account                                 |
| `PATCH /v1/plans/{planId}`    | Change the name or limits of one of the account's custom plans            |
| `POST /v1/users`              | Register a user; it starts on the predefined Basic plan                   |
| `GET /v1/users`               | The account's users with their plans, oldest first                        |
| `GET /v1/users/{userId}`      | One user of the account with its plan                                     |
| `PUT /v1/users/{userId}/plan` | Switch a user's plan                                                      |
| `PUT /v1/account/plan`        | Switch the account's plan                                                 |

### Plans

Every plan has a scope: `ACCOUNT` plans apply to the account's shared allowance and `USER` plans to
each user's own allowance. The four predefined plans are visible to every account and read-only:

| Code      | Scope   | Monthly allowance | Max units per request |
| --------- | ------- | ----------------- | --------------------- |
| `starter` | ACCOUNT | 10,000            | 100                   |
| `pro`     | ACCOUNT | 100,000           | 1,000                 |
| `basic`   | USER    | 1,000             | 20                    |
| `premium` | USER    | 10,000            | 100                   |

`GET /v1/plans?scope=ACCOUNT` or `?scope=USER` (exact upper case) narrows the list. Custom plans
have `"code": null` and are visible only to the account that created them:

```bash
curl -s -X POST http://127.0.0.1:8080/v1/plans \
  -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Team", "scope": "ACCOUNT", "monthlyAllowance": 50000, "maxUnitsPerRequest": 500}'
```

- Names follow the account-name rules; limits are JSON integers from 1 to 1,000,000,000 (strings
  such as `"500"` are rejected, never converted).
- `PATCH /v1/plans/{planId}` accepts any non-empty subset of `name`, `monthlyAllowance` and
  `maxUnitsPerRequest`; the scope cannot change. A predefined plan returns
  `409 PLAN_READ_ONLY`. Accounts and users already on the plan see the new limits immediately.

### Users

`POST /v1/users` with `{"name": "..."}` registers a user under the authenticated account on the
predefined Basic plan; the plan is assigned in the same statement that creates the user. User names
follow the account-name rules and need not be unique. The response (also used by `GET` and the
plan switch) is:

```json
{
  "id": "<user-id>",
  "name": "Ada",
  "createdAt": "2026-10-13T09:30:15.123Z",
  "updatedAt": "2026-10-13T09:30:15.123Z",
  "plan": {
    "id": "b0000000-0000-4000-8000-000000000001",
    "code": "basic",
    "name": "Basic",
    "scope": "USER",
    "monthlyAllowance": 1000,
    "maxUnitsPerRequest": 20
  }
}
```

`GET /v1/users` returns `{"users": [...]}` in creation order. An unknown user and another
account's user both return `404 NOT_FOUND` with the message `User not found`.

### Switching plans

`PUT /v1/account/plan` and `PUT /v1/users/{userId}/plan` take `{"planId": "<uuid>"}` and return the
updated account or user. The plan must be a predefined plan or one of the account's own custom
plans, of the matching scope. Checks apply in this order:

1. Unknown or foreign user: `404 NOT_FOUND`, `User not found`.
2. Unknown or foreign plan: `404 NOT_FOUND`, `Plan not found`.
3. A plan of the other scope (for example `premium` for the account): `409 PLAN_SCOPE_MISMATCH`.

A failed switch changes nothing. Assigning the plan that is already assigned succeeds and returns
the unchanged resource, including its previous `updatedAt`; a real change sets `updatedAt`.

## Consuming units

`POST /v1/consume` (requires `X-API-Key`) asks whether a user of the authenticated account may
consume units now, and counts them if so.

```bash
curl -s -X POST http://127.0.0.1:8080/v1/consume \
  -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "<user-id>", "units": 10, "requestId": "doc-2026-10-13-0001"}'
```

| Field       | Rule                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| `userId`    | UUID of a user of the authenticated account                                           |
| `units`     | JSON integer from 1 to 1,000,000,000 (`"10"`, `10.5`, `0` and negatives are rejected) |
| `requestId` | 1-128 characters from `A-Z a-z 0-9 . _ : -`, chosen by the caller; unique per account |

Unknown fields are rejected. **Every decision is `200 OK`**, whether accepted or not:

```json
{
  "requestId": "doc-2026-10-13-0001",
  "userId": "<user-id>",
  "units": 10,
  "accepted": false,
  "blockingRule": "MONTHLY_ALLOWANCE",
  "blockingLevel": "ACCOUNT",
  "month": "2026-10",
  "processedAt": "2026-10-13T09:30:15.123Z",
  "account": {
    "planId": "a0000000-0000-4000-8000-000000000001",
    "planName": "Starter",
    "monthlyAllowance": 10000,
    "maxUnitsPerRequest": 100,
    "used": 9995,
    "remaining": 5
  },
  "user": {
    "planId": "b0000000-0000-4000-8000-000000000001",
    "planName": "Basic",
    "monthlyAllowance": 1000,
    "maxUnitsPerRequest": 20,
    "used": 120,
    "remaining": 880
  }
}
```

- **Rules.** A request is accepted only when all four checks pass. They are evaluated in this fixed
  order and the first failure is reported as `blockingRule` and `blockingLevel`:
  1. user `MAX_UNITS_PER_REQUEST`
  2. account `MAX_UNITS_PER_REQUEST`
  3. user `MONTHLY_ALLOWANCE`
  4. account `MONTHLY_ALLOWANCE`

  Exactly reaching a limit is allowed. An accepted request adds its units to both the user's and
  the account's usage for the month. A rejection counts nothing. Both `blockingRule` and
  `blockingLevel` are `null` when accepted.

- **Usage values.** `used` is the month's usage after this decision. `remaining` is
  `monthlyAllowance - used`, shown as `0` (never negative) when an allowance was reduced below
  existing usage; further requests at that level are rejected until allowance is available again.
- **Months.** Usage belongs to the UTC calendar month in which the request is processed (`month`,
  `YYYY-MM`). Each month starts at zero; previous months keep their totals.
- **Plan changes.** Each decision records the plan IDs, names and all four limits it used. Plan
  updates and switches apply to requests that start after they succeed, and never change a
  recorded decision. A request in flight uses either the complete old state or the complete new
  state, never a mix.

### Retries and idempotency

The `requestId` makes retries safe. The decision for each `(account, requestId)` is stored once.

- Retrying with the **same `userId` and `units`** returns the original response, byte for byte.
  This holds for accepted and rejected decisions alike, and even after plan changes or the start
  of a new month. Nothing is counted again.
- Reusing a `requestId` with a **different `userId` or `units`** returns `409 IDEMPOTENCY_CONFLICT`
  and changes nothing.
- Request IDs are scoped to the account: another account may use the same value independently.

| Status                     | Meaning                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `200`                      | A decision (accepted or rejected)                                                                            |
| `400 VALIDATION_ERROR`     | Malformed body; nothing recorded                                                                             |
| `401 UNAUTHORIZED`         | Missing or invalid API key                                                                                   |
| `404 NOT_FOUND`            | `User not found`: unknown, or a user of another account (same response); nothing recorded                    |
| `409 IDEMPOTENCY_CONFLICT` | `requestId` already used with a different payload                                                            |
| `503 BUSY_RETRY`           | Too much contention on this account; nothing recorded. Retry the same request after `Retry-After` (1 second) |

After a `500` or a network failure the client cannot know whether a decision was recorded; retrying
with the same `requestId` is always safe and returns the decision if there is one.

**Configuration:** `DB_LOCK_TIMEOUT_MS` (default 2000) bounds how long a request waits for the
account's usage counter before answering `503 BUSY_RETRY`.

## Health checks and API documentation

| Endpoint            | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | `200 {"status":"ok"}` while the process runs; never touches the database                          |
| `GET /health/ready` | `200 {"status":"ready"}` only when PostgreSQL is reachable and every shipped migration is applied |
| `GET /docs`         | Interactive OpenAPI documentation (`GET /docs/json` for the raw document)                         |

When not ready, `/health/ready` returns `503` with the standard error body, for example:

```json
{ "error": { "code": "SERVICE_UNAVAILABLE", "message": "The database is not reachable" } }
```

The Docker image's health check calls `/health/ready`.

## Running the tests

Integration tests need PostgreSQL and a **dedicated test database whose name ends in `_test`**,
set through `TEST_DATABASE_URL` (in `.env` locally). With the Compose database running:

```bash
docker compose up --detach postgres
npm test
```

If port 5432 is already taken on your machine, start the database on another port and point the
tests at it, for example `POSTGRES_HOST_PORT=15432` with
`TEST_DATABASE_URL=postgres://usage_metering:local-development-only@127.0.0.1:15432/usage_metering_test`.

Test database safety:

- The test run **drops and recreates** the database named in `TEST_DATABASE_URL`, and tests reset
  its schema between cases. Every helper that does this refuses to touch a database whose name does
  not end in `_test`, so a development or production database cannot be wiped by mistake.
- The test database is created automatically through the server's `postgres` maintenance
  database, so the configured user needs permission to create databases (the Compose user has it).

CI runs the same suite against a PostgreSQL 16 service container, and separately builds the Docker
image, starts the Compose stack and checks health, user, logs and graceful shutdown.
