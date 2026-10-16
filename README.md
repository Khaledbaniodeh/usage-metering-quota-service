# Usage Metering and Quota Service

A backend service that other applications call to record usage and decide whether their users may
perform an action. Each account has a shared monthly allowance and each of its users has an
individual allowance; a request is accepted only when every applicable account and user rule allows
it.

## Status

**Implementation Phase 6: example client and end-to-end Compose verification.**

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
- Monthly usage for the account and each user, the immutable decision history, and keyset
  pagination with opaque cursors for the user, usage and history lists.
- One catalogue of stable error codes behind a single JSON error shape.
- Liveness and readiness endpoints and generated OpenAPI documentation.
- Production Docker image and a Docker Compose stack (service + PostgreSQL).
- Unit tests, and integration tests against a real PostgreSQL database, including an
  account-isolation harness.
- A typed example client that exercises the whole public API, run end to end against the Compose
  stack in CI.

**Not implemented yet:** load tests. They arrive in later, separately verified phases described in
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
| `GET /v1/users`               | The account's users with their plans, oldest first, paginated             |
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

`GET /v1/users` returns `{"users": [...], "nextCursor": ...}` in creation order, one page at a
time (see [Pagination](#pagination)). An unknown user and another
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

## Usage

All usage endpoints require `X-API-Key` and report one UTC calendar month. `month` is `YYYY-MM`
and defaults to the current UTC month; a future month is `400`. Usage counts accepted requests
only, and a month without usage reports `0` (never `404`).

| Endpoint                                    | Returns                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `GET /v1/usage?month=`                      | The account's shared usage                                  |
| `GET /v1/users/{userId}/usage?month=`       | One user's usage (unknown and other accounts' users: `404`) |
| `GET /v1/usage/users?month=&limit=&cursor=` | Every user's usage, newest user first, paginated            |

The **current month** includes the limits of the plan assigned now:

```json
{
  "month": "2026-10",
  "used": 120,
  "monthlyAllowance": 1000,
  "maxUnitsPerRequest": 20,
  "remaining": 880
}
```

A **past month** reports `{"month": "2026-09", "used": 340}` only. Today's plan says nothing
about the limits that applied then, so no remaining value is invented; the limits that applied to
each request are recorded on its decision in `GET /v1/history`.

- `remaining = max(0, monthlyAllowance - used)`: when an allowance was reduced below usage it
  shows `0`, and further requests at that level are rejected until allowance is available again.
- Switching plans keeps the month's usage; it never grants a fresh allowance.
- The account's `used` is the sum of its users' accepted usage.

`GET /v1/usage/users` returns `{"month", "currentMonth", "users": [...], "nextCursor"}`. With
`currentMonth: true` each user has `userId`, `name`, `planId`, `planName`, `used`,
`monthlyAllowance`, `maxUnitsPerRequest` and `remaining`; with `currentMonth: false` (a past
month) each user has `userId`, `name` and `used`. Every user is listed, with `used: 0` when it has
no usage in that month.

## Decision history

`GET /v1/history?userId=&month=&limit=&cursor=` (requires `X-API-Key`) lists the account's
consume decisions, newest first:

```json
{
  "userId": null,
  "month": "2026-10",
  "decisions": [
    { "requestId": "doc-1", "accepted": true, "...": "exactly the POST /v1/consume body" }
  ],
  "nextCursor": "eyJ2IjoxLCJrIjoiaGlzdG9yeSIs..."
}
```

- Each decision is **exactly the body `POST /v1/consume` returned**, rebuilt from the stored
  record: plan IDs, names and all four limits as they were at that moment, with `used` and
  `remaining` after that decision. Later plan updates or switches never change it.
- Optional filters: `userId` (a user of the account; an unknown user and another account's user
  both get `404 User not found`) and `month` (`YYYY-MM`, UTC; a future month is `400`). The
  response echoes the filters in effect (`null` when not filtered).

## Pagination

`GET /v1/users`, `GET /v1/usage/users` and `GET /v1/history` return one page at a time:

- `limit`: an integer from 1 to 100 written plainly (no sign, decimal point, exponent, spaces or
  leading zeros); default 20.
- `nextCursor`: pass it as `cursor` to get the next page; it is `null` on the last page. Pages are
  never addressed by offset.
- A continuation request may send only `cursor` (and optionally a different `limit`). The cursor
  carries the traversal's filters (`month`; `userId` for history): a request may repeat them
  exactly but not change them.
- Every unusable cursor gets the same response:
  `400 {"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}`. That includes malformed
  values, a cursor from another endpoint, changed filters, an expired cursor (below) and a cursor
  pointing at a row that is not visible to the caller.

| Endpoint              | Order                 | Notes                                                     |
| --------------------- | --------------------- | --------------------------------------------------------- |
| `GET /v1/users`       | Oldest user first     | Users created during a traversal appear on later pages    |
| `GET /v1/usage/users` | Newest user first     | A current-month traversal expires when the UTC month ends |
| `GET /v1/history`     | Newest decision first | New decisions appear only in a new traversal              |

**Cursor format.** A cursor is opaque to clients but **not secret and not tamper-proof**: it is
unpadded base64url of a small JSON object (version, endpoint, the UUID of the last row returned,
and the bound filters). It is not signed or encrypted. Authorization never comes from the cursor:
every lookup and page query is restricted to the authenticated account in SQL, so a modified
cursor can at most move the caller within its own data, and a cursor naming another account's row
is simply invalid. Cursors never contain API keys, hashes, SQL or internal sequence numbers.

**`GET /v1/users` is now paginated.** Until Phase 5 it returned every user in one response. It
now returns `{"users": [...], "nextCursor": ...}` with at most 20 users by default. An account with
up to 20 users receives the same complete list as before, plus `nextCursor: null`. This is a
deliberate pre-release contract change.

### Known limitations

| Limitation                                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No duplicates; no gaps only for committed data | Pages never repeat a row, and a traversal over data that does not change returns every row once. A row whose position was allocated before a page boundary but that **commits after** that page was read is missed by that traversal (a new traversal includes it). For users this window is a concurrent user creation. For decisions it exists only for two requests of one account straddling a UTC month boundary: within one month the account's usage lock makes decisions commit in order. Both cases are reproduced by tests. |
| Current-month cursor expiry                    | A `GET /v1/usage/users` traversal of the current month becomes invalid when the UTC month changes, so its pages never switch between the current and past-month forms. Restart with `month=<that month>` to page through it as a past month.                                                                                                                                                                                                                                                                                          |
| Usage lists are not a snapshot                 | Each page of `GET /v1/usage/users` reads usage and the live plan when it is served, so values on different pages can reflect different moments.                                                                                                                                                                                                                                                                                                                                                                                       |
| History filtered by both user and month        | Served by the existing `(account_id, user_id, seq)` or `(account_id, month, seq)` index plus a filter. For a user with a very large history asking about an old month, the first page scans that user's newer decisions. A combined index is deferred until load tests show it is needed (see the architecture notes).                                                                                                                                                                                                                |

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

## Example client

`client/` holds a small TypeScript client for the public HTTP API and an example workflow that
uses it. It is built on Node 22's native `fetch`, adds no dependency, and knows only the documented
contract: no database access and no service internals. It is excluded from the Docker image.

Run it against a running stack (for example `docker compose up --build --wait`):

```bash
npm run client:example
```

| Variable       | Default                 | Meaning                                                             |
| -------------- | ----------------------- | ------------------------------------------------------------------- |
| `API_BASE_URL` | `http://127.0.0.1:8080` | Service root; http or https, without credentials, query or fragment |

The workflow creates a new, uniquely named account each run, so it can be repeated against the
same stack. It prints one line per step and a summary of IDs and counts:

1. Checks `/health/live` and `/health/ready`.
2. Creates an account and three users.
3. Sends an accepted request (5 units).
4. Retries it with the same `requestId` and requires the identical response, byte for byte.
5. Sends a second accepted request (7 units) for another user.
6. Sends one unit above the user plan's per-request limit, which must be rejected with
   `MAX_UNITS_PER_REQUEST` at `USER` level, with usage unchanged.

   Every decision must echo the `requestId`, `userId` and `units` that were sent.

7. Checks account usage (12 units) and each user's usage (5, 7, 0).
   - Account usage is read without `month`, which reports the current month: it must be the
     decisions' month, in the current-month form.
   - Every usage response must carry `monthlyAllowance`, `maxUnitsPerRequest` and `remaining`
     together or not at all. When present, each must match the plan.
8. Walks `GET /v1/users`, `GET /v1/usage/users` and `GET /v1/history` with `limit=1` until
   `nextCursor` is `null`.
   - **All lists:** no duplicates, and the expected order and values.
   - **`/v1/usage/users`:** every page has the same `currentMonth`, matching the other usage
     responses. On current-month pages, each user's plan ID, plan name, limits and `remaining`
     are checked.
   - **`/v1/history`:** exactly three decisions, each equal to its original response.
   - With usage at 12, this proves the retry neither counted nor recorded anything.

Expectations are derived from the API's own responses (plan limits, IDs, the decisions' `month`),
never from the local clock. If the UTC month changes during a run, the usage forms legitimately
change; the client detects this through the API and asks for a rerun instead of reporting a
defect.

**Exit codes and errors:**

- `0`: the workflow passed.
- `1`: a step failed. The message names the step and the failed call or check, for example:

  ```text
  Example client failed at step "accepted request": POST /v1/consume: expected HTTP 200, got 409 IDEMPOTENCY_CONFLICT
  ```

- `2`: `API_BASE_URL` is invalid.

Every request has a 10 second deadline, enforced with `AbortController`.

**The API key never leaves memory:**

- The key returned at account creation is wrapped immediately. `String`, `JSON.stringify` and
  `util.inspect` all show `[REDACTED]`; only the `X-API-Key` request header receives the key.
- A failed call is described only by the endpoint (method, documented path and its own query),
  the HTTP status and the service's error code. Never included: the configured base URL or path
  prefix, request headers, the service's error message, or any other response content.
- Every printed line also passes through a filter that replaces anything key-shaped.

## Running the tests

| Kind           | Command                                       | Needs                         | What it proves                                                                                       |
| -------------- | --------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit           | `npm run test:unit`                           | Nothing                       | Pure rules, configuration, the HTTP contract with stubs, and the example client                      |
| Client unit    | `npm run test:client`                         | Nothing                       | The example client's own behavior (subset of the unit tests)                                         |
| Integration    | `npm run test:integration`                    | PostgreSQL (`_test` database) | Repositories, transactions, concurrency, isolation, pagination, API over real SQL                    |
| End to end     | `npm run test:e2e`                            | A running stack               | The real client executable passes the whole workflow and prints no key                               |
| Load (Phase 7) | `perf-smoke` / `perf-full` pull-request label | GitHub Actions                | Throughput, latency and invariants under load; results in [docs/performance.md](docs/performance.md) |

`npm test` runs the unit and integration tests; `npm run check` adds formatting, lint, type-check
and the build. The end-to-end test is a black-box check through the public API only. It
complements the integration tests, does not replace them, and is not a load test.

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

### Continuous integration

GitHub Actions runs two jobs on every pull request and every push to `main`:

**Quality gates and tests:** `npm ci`, formatting, lint, type-check, the unit and integration
tests with coverage thresholds against a PostgreSQL 16 service container, and the build.

**Container image and Compose stack:**

1. `npm ci` with Node from `.nvmrc`, used only for the example client.
2. Build the production image.
3. `docker compose down --volumes`, then `docker compose up --build --wait`, so the stack starts
   from a fresh database volume.
4. Check both health endpoints and that the service does not run as root.
5. Run `npm run test:e2e` against `http://127.0.0.1:8080`. The output is saved to a file and only
   a redacted copy is printed.
6. Fail if the API logs or the client output contain anything API-key-shaped, the database
   password, or (API logs) an error-level entry.
7. Stop the API and require exit code 0 and a completed graceful shutdown.
8. On failure, print redacted Compose logs. Always run `docker compose down --volumes`. No
   artifacts are uploaded.
