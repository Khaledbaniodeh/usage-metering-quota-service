# Usage Metering and Quota Service

A backend service that other applications call to record usage and decide whether their users may
perform an action. Each account has a shared monthly allowance and each of its users has an
individual allowance; a request is accepted only when every applicable account and user rule allows
it.

## Status

All behavior required by the project specification is implemented and checked by automated tests
and CI; [docs/requirements-traceability.md](docs/requirements-traceability.md) maps each requirement
to its implementation and evidence:

- **Accounts and API keys:** account creation with a one-time key, `X-API-Key` authentication and
  strict tenant isolation.
- **Plans and users:** four predefined plans, custom plans (create, update), users, and plan
  switching for the account and each user.
- **Quota decisions:** `POST /v1/consume` applies the account and user plans together, counts
  accepted units atomically and records every decision with the plans it used.
- **Safe retries:** idempotent request IDs, with byte-identical replays and `409` for a reused ID.
- **Usage and history:** current and past months for the account and each user, and the decision
  history, all with cursor pagination.
- **Example client:** a one-shot Docker Compose service that demonstrates every required behavior.
- **Proof:** unit tests; integration tests against real PostgreSQL, including deterministic
  concurrency, plan-change, restart and tenant-isolation tests; an end-to-end Compose run in CI
  with a persistence check across a stack rebuild.
- **Performance:** committed load-test tooling and the results of a full benchmark
  ([docs/performance.md](docs/performance.md)).

The results describe the measured environment; the specification sets no service-level targets
(see [Known limitations](#known-limitations)).

## Quick start

**Prerequisites:** Docker with Docker Compose v2. Node.js 22 is needed only to run the service or
the tests outside containers.

```bash
docker compose up --build
```

No configuration file is required. Compose uses the defaults in [compose.yaml](compose.yaml); to
change them, copy [.env.example](.env.example) to `.env` (git-ignored) and edit it. **Every
credential in these files is a development-only placeholder**, such as the database password
`local-development-only`; never use them outside your machine.

If port `5432` or `8080` is already in use, set `POSTGRES_HOST_PORT` or
`API_HOST_PORT` to another free host port in `.env` (for example, `15432` and
`18080`). When `API_HOST_PORT` changes, use that port in the URLs below. The
example client is unaffected because it reaches the API through the internal
Compose network.

`docker compose up --build` starts:

1. **PostgreSQL 16**, with its data in the named volume `postgres-data`.
2. **The API**, which applies the migrations and the predefined plans before it listens.
3. **The example client**, once the API reports healthy. It runs the complete example workflow
   once and exits.

The client succeeds when its output (prefixed `client-1`) ends with `Example workflow passed: …`
and Compose reports that it exited with code 0. Any failed check names the step and exits with
code 1. The database and the API keep running.

| URL                                  | What                                       |
| ------------------------------------ | ------------------------------------------ |
| `http://127.0.0.1:8080`              | The API (loopback only; `API_HOST_PORT`)   |
| `http://127.0.0.1:8080/health/live`  | Liveness                                   |
| `http://127.0.0.1:8080/health/ready` | Readiness: database reachable and migrated |
| `http://127.0.0.1:8080/docs`         | Interactive OpenAPI documentation          |

```bash
docker compose run --rm client   # run the example client again; its exit code is the result
docker compose down              # stop and remove the containers; the database volume is kept
docker compose down --volumes    # also delete the database volume and all its data
```

## Documentation

| Document                                                                     | Contents                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [docs/api.md](docs/api.md)                                                   | Every endpoint, with requests, responses, errors and a walkthrough |
| [docs/architecture.md](docs/architecture.md)                                 | Components, data model, the consume transaction, concurrency       |
| [docs/performance.md](docs/performance.md)                                   | Load-test method, environment, results and decisions               |
| [docs/requirements-traceability.md](docs/requirements-traceability.md)       | Each requirement with its implementation, tests and evidence       |
| [docs/evidence/perf-full-38751721971/](docs/evidence/perf-full-38751721971/) | The preserved benchmark evidence                                   |

## Product assumptions

The specification leaves some behavior open. These are the choices, applied everywhere:

1. **One metered resource, in whole units.** Units, limits and requests are JSON integers from 1
   to 1,000,000,000; strings and decimals are rejected, never converted. The specification asks for
   one resource throughout, and integers keep every total exact.
2. **UTC calendar months.** Usage belongs to a month written `YYYY-MM` in UTC, so every caller and
   every server agrees on the month regardless of time zone.
3. **The month is fixed once, when processing starts.** For a new request the service reads its
   clock once, before the transaction and before any lock wait; the decision, both counters and the
   history record all use that month. One instant per decision means a decision is never split
   across two months.
4. **A request can commit just after midnight UTC and still count in the earlier month.** That
   happens when it starts in the last moment of a month and waits for the account's counter lock
   (at most `DB_LOCK_TIMEOUT_MS`, 2 seconds by default). Re-reading the clock under the lock would
   instead make the month depend on contention.
5. **Current-month usage shows the live plan.** It includes `monthlyAllowance`,
   `maxUnitsPerRequest` and `remaining` from the plans assigned now, because that answers what a
   user can still do.
6. **Past months report `used` only.** Plans may have changed since, so today's limits say nothing
   about that month's entitlement. The limits that applied to each request are recorded on its
   decision in the history.
7. **Every valid consume decision is HTTP 200.** A rejection is a successful evaluation, not a
   client error: `accepted` is `false`, and `blockingRule` and `blockingLevel` name the first rule
   that failed. HTTP errors mean the request could not be decided (`400`, `401`, `404`, `409`,
   `503`), and a retry of a rejected request replays the same `200` body.
8. **Request IDs are scoped to the account.** `(account, requestId)` is unique, so each caller picks
   its own IDs, and accounts can neither collide with nor probe each other.
9. **A reused request ID must carry the same request.** The same `userId` and `units` return the
   original response byte for byte and count nothing; anything else is `409 IDEMPOTENCY_CONFLICT`,
   so a retry can never turn into a different decision.
10. **Unknown and foreign resources look the same.** A user or plan of another account gets exactly
    the response of one that does not exist (`404 User not found`, `404 Plan not found`), so a key
    never reveals another account's data. Users must be registered before they consume.
11. **Predefined plans and defaults.** Starter (10,000 a month, 100 per request) and Pro (100,000,
    1,000) for accounts; Basic (1,000, 20) and Premium (10,000, 100) for users. They are read-only.
    New accounts start on Starter and new users on Basic, so a new account works at once.
12. **Account and user plans apply together.** Four checks run in a fixed order: user per-request,
    account per-request, user monthly, account monthly. The first failure is reported, so the
    reason is deterministic. A user plan never raises the account's shared allowance.
13. **No additional rules.** Each plan has exactly the two required rules (monthly allowance and
    maximum per request). A reliable core was preferred to extra rule types.
14. **API keys are shown once and stored only as a SHA-256 digest.** The key appears only in the
    account-creation response. A database leak exposes no usable key; a lost key cannot be
    recovered, and rotation is out of scope.

## Account and user model

- An **account** is a calling application. It has exactly one account-level plan, which defines the
  allowance shared by all its users.
- A **user** belongs to exactly one account and has exactly one user-level plan, which defines that
  user's own allowance.
- **Plans** are either predefined (visible to every account, read-only) or custom (owned by one
  account and visible only to it). Each plan has a scope, `ACCOUNT` or `USER`, and can be assigned
  only at that level.
- **Many users can share one plan definition** and still have independent allowances: usage is
  counted per user, never per plan.
- **An accepted request counts twice, atomically:** in the user's monthly counter and in the
  account's monthly counter, in one transaction. A rejection counts nothing. The account's usage is
  therefore always the sum of its users' accepted usage.
- **Plan changes** (updating a custom plan or switching plans) apply to requests that start after
  they succeed. Usage already counted in the month is kept, and recorded decisions never change.

## API

All endpoints are documented with request and response examples in [docs/api.md](docs/api.md)
and as OpenAPI at `GET /docs` (`GET /docs/json`). Every error has the shape
`{"error": {"code": "...", "message": "..."}}`, and every protected endpoint answers a missing or
invalid key with `401 UNAUTHORIZED`.

| Method | Path                       | Key | Purpose                                         | Main statuses      |
| ------ | -------------------------- | --- | ----------------------------------------------- | ------------------ |
| POST   | `/v1/accounts`             | no  | Create an account; returns its API key once     | 201, 400           |
| GET    | `/v1/account`              | yes | The authenticated account and its plan          | 200                |
| PUT    | `/v1/account/plan`         | yes | Switch the account's plan                       | 200, 404, 409      |
| GET    | `/v1/plans`                | yes | Predefined and own custom plans (`?scope=`)     | 200, 400           |
| POST   | `/v1/plans`                | yes | Create a custom plan                            | 201, 400           |
| PATCH  | `/v1/plans/{planId}`       | yes | Update an own custom plan                       | 200, 404, 409      |
| POST   | `/v1/users`                | yes | Register a user (on Basic)                      | 201, 400           |
| GET    | `/v1/users`                | yes | The account's users, paginated                  | 200, 400           |
| GET    | `/v1/users/{userId}`       | yes | One user and its plan                           | 200, 404           |
| PUT    | `/v1/users/{userId}/plan`  | yes | Switch a user's plan                            | 200, 404, 409      |
| POST   | `/v1/consume`              | yes | Decide and record a request for units           | 200, 404, 409, 503 |
| GET    | `/v1/usage`                | yes | The account's usage for a month (`?month=`)     | 200, 400           |
| GET    | `/v1/users/{userId}/usage` | yes | One user's usage for a month                    | 200, 404           |
| GET    | `/v1/usage/users`          | yes | Every user's usage for a month, paginated       | 200, 400           |
| GET    | `/v1/history`              | yes | Decisions, newest first (`?userId=`, `?month=`) | 200, 400, 404      |
| GET    | `/health/live`             | no  | Liveness                                        | 200                |
| GET    | `/health/ready`            | no  | Readiness                                       | 200, 503           |
| GET    | `/docs`, `/docs/json`      | no  | OpenAPI documentation                           | 200                |

Every body-taking endpoint also answers `413` and `415`, and any endpoint can answer
`500 INTERNAL_ERROR` without internal details. The core flow, with placeholders written `<...>`
and example response values:

```bash
API=http://127.0.0.1:8080
curl -s -X POST "$API/v1/accounts" -H "Content-Type: application/json" -d '{"name": "Acme"}'
export UMQS_API_KEY='<apiKey from the response, shown only once>'

curl -s -X POST "$API/v1/users" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" -d '{"name": "Ada"}'
export USER_ID='<id from the response>'

curl -s -X POST "$API/v1/consume" -H "X-API-Key: $UMQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"units\": 10, \"requestId\": \"order-1001\"}"

curl -s "$API/v1/usage" -H "X-API-Key: $UMQS_API_KEY"
curl -s "$API/v1/history?userId=$USER_ID&limit=20" -H "X-API-Key: $UMQS_API_KEY"
```

The consume response is a decision such as `"accepted": true` with the user's and the account's
`used` and `remaining` units. Plan creation, updates and switches, both kinds of rejection,
pagination with cursors and every error are shown step by step in the
[API walkthrough](docs/api.md#walkthrough-every-business-operation).

## Example client

`client/` holds a small TypeScript client for the public HTTP API and an example workflow that
uses it. It is built on Node 22's native `fetch`, adds no dependency, and knows only the documented
contract: no database access and no service internals.

**Run it with Docker Compose** (the `client` service, built from
[Dockerfile.client](Dockerfile.client)):

```bash
docker compose up --build        # runs the client once, after the service is healthy
docker compose run --rm client   # runs it again; the command's exit code is the client's
```

The client container reaches the service at `http://api:8080`, its only configuration. It never
receives database settings, runs as the unprivileged `node` user, and its image holds only the
compiled client: no service source and no `node_modules`.

**Or run it from the host** against a running service:

```bash
npm run client:example
```

| Variable       | Default                 | Meaning                                                             |
| -------------- | ----------------------- | ------------------------------------------------------------------- |
| `API_BASE_URL` | `http://127.0.0.1:8080` | Service root; http or https, without credentials, query or fragment |

The workflow creates a new, uniquely named account each run, so it can be repeated against the
same stack. It prints one line per step. With the predefined plans (Starter 10,000 units a month
and 100 per request for the account; Basic 1,000 and 20, Premium 10,000 and 100 for users) it
demonstrates:

1. **Different plans in one account:** three users are created on Basic, user 2 is switched to
   Premium, and both users are read back with the account's key.
2. **An accepted request:** user 1 (Basic) consumes 10 units. Its retry with the same `requestId`
   returns the identical response, byte for byte, and account usage stays at 10.
3. **A rejection by the user's limit:** user 1 asks for 25 units, above Basic's 20 per request.
   It is rejected with `MAX_UNITS_PER_REQUEST` at `USER` level, and nothing is counted.
4. **The other plan allows it:** user 2 (Premium) consumes the same 25 units. Account usage: 35.
5. **A rejection by the shared account limit:** a custom `ACCOUNT` plan allowing exactly 35 units a
   month is created and assigned to the account. User 2 asks for 5 units, which Premium allows; it
   is rejected with `MONTHLY_ALLOWANCE` at `ACCOUNT` level, and nothing is counted.
6. **A plan change, with no client change:** the custom plan is raised to 40 units, and the same
   5-unit request (with a new `requestId`) is accepted.
7. **Usage and history:** account usage is 40 = 10 + 30 + 0 for the three users, and
   `GET /v1/users`, `GET /v1/usage/users` and `GET /v1/history` are walked with `limit=1`
   until `nextCursor` is `null`. The history holds exactly the five decisions, each equal to
   its original response.

Every decision is printed as one line with its request ID, the outcome, the blocking rule and
level of a rejection, and for the user and the account the plan, the units used and the units
remaining, for example:

```text
[ok] account-limit rejection: <run>-account-rejected: REJECTED 5 units by ACCOUNT MONTHLY_ALLOWANCE | user "Premium" 25 used, 9975 remaining | account "Example shared cap" 35 used, 0 remaining; user plan alone would allow it (5 <= 100 per request, 9975 remaining); nothing was counted
```

Each decision is checked exactly: the echoed request, the outcome, and for both levels the plan,
limits, usage and remaining units. Usage responses must carry `monthlyAllowance`,
`maxUnitsPerRequest` and `remaining` together or not at all, matching the plan. Expectations are
derived from the API's own responses (plan limits, IDs, the decisions' `month`), never from the
local clock. If the UTC month changes during a run, the client detects this through the API and
asks for a rerun instead of reporting a defect.

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

## Main design decisions

Details and the reasoning behind each are in [docs/architecture.md](docs/architecture.md).

- **PostgreSQL is the only source of truth.** Accounts, users, plans, assignments, monthly counters
  and every decision live in one database. No cache or in-process state can disagree with it.
- **One transaction per decision, with a fixed lock order.** A new consume reads both plans in one
  statement, then locks the account's monthly counter row and then the user's, evaluates the four
  rules, updates both counters only when accepted and inserts the decision, all in one
  `READ COMMITTED` transaction. The fixed order rules out deadlocks; waiting is bounded by a lock
  timeout that answers `503 BUSY_RETRY`.
- **Three layers of idempotency.** A fast lookup answers retries without a transaction, a re-check
  under the account lock catches a concurrent duplicate, and the unique `(account_id, request_id)`
  constraint is the backstop for the rare case the lock cannot cover (duplicates straddling a month
  boundary).
- **Account-scoped SQL.** The account always comes from the API key, and every query is
  restricted to it; composite foreign keys keep users and counters inside their account.
- **Hashed API keys:** only a SHA-256 digest is stored, and the logger redacts the `X-API-Key`
  header and connection strings.
- **UTC month keys:** counters are keyed by the first day of the UTC month.
- **Immutable decisions:** each decision stores the plan IDs, names and all four limits it was
  decided with, and the database refuses updates and deletes, so history and replays never change.
- **Keyset pagination with filter-bound cursors:** pages follow an internal sequence, and the
  cursor fixes the traversal's filters, so pages never repeat rows or silently change filters.
- **Safe startup and shutdown:** migrations are checksummed and serialized by an advisory lock and
  run before the service listens; readiness requires every migration; shutdown drains requests
  within a deadline.
- **Non-root containers:** the API and the example client run as the unprivileged `node` user, and
  the client image contains only the compiled client.
- **No speculative index.** A combined history index was rejected by measurement: the heavy-user
  history page took a median p95 of 2.359 ms with 4 rows discarded, far below the decision
  thresholds (see [Performance](#performance)).

## Performance

The full benchmark ran on GitHub Actions
([run 38751721971](https://github.com/Khaledbaniodeh/usage-metering-quota-service/actions/runs/38751721971),
commit `d0cc2b0`; the service code is unchanged since). The environment was a 4-vCPU AMD EPYC 7763
runner, with PostgreSQL limited to 2 CPUs and 2 GiB and the API to 1 CPU and 1 GiB. Full method,
results and evidence: [docs/performance.md](docs/performance.md).

- **Dataset:** 1,498,000 stored decisions; the heavy user owns 1,200,000 of them.
- **History:** the first page of the heavy user's oldest month had a median p95 of **2.359 ms** at
  20 requests per second. EXPLAIN shows a backward scan of the existing `(account_id, month, seq)`
  index, with no sort and 4 rows removed by the filter. **No new index is justified** under the
  pre-registered rule (p95 above 50 ms, or more than 2,000 rows removed).
- **Consume:** median p95 **5.999 ms** for 50 accounts × 20 users at 50 requests per second, and
  **6.800 ms** for one account with 200 users at 20 per second, with no dropped requests, no
  `BUSY_RETRY` and every invariant intact.
- **Whole service:** 200 requests per second spread over 100 accounts ran at p95 6.466 ms.
- **One busy account:** about **158 requests per second** were completed, because an account's
  decisions run one at a time on its counter lock. Above that, requests queued; none failed.

The specification sets no throughput or latency target, so these are measurements of one
environment, not guarantees.

## Development

### Running locally with npm

Requires Node.js 22 (see [.nvmrc](.nvmrc); minimum `22.13.0`). Install the dependencies,
copy the example configuration, start only the database and run the service from source:

```bash
npm ci
cp .env.example .env
```

Every variable is documented in [.env.example](.env.example); the values there are
**local development only** examples. `.env` is git-ignored and must never be committed. The service
reads all configuration through [src/config/config.ts](src/config/config.ts) and refuses to start
when a value is missing or invalid; only `DATABASE_URL` is required.

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
| `npm run test:coverage`    | All tests with V8 coverage of `src/` and the enforced 80% thresholds    |
| `npm run test:client`      | The example client's unit tests                                         |
| `npm run test:load`        | The load-test tooling's unit tests                                      |
| `npm run test:e2e`         | The end-to-end check of one example-client run (needs a running stack)  |
| `npm run client:example`   | Run the example client from the host against `API_BASE_URL`             |
| `npm run build:client`     | Compile the example client to `dist/client/` (used by its image)        |
| `npm run format:check`     | Verify Prettier formatting (`npm run format` applies it)                |
| `npm run lint`             | ESLint (type-aware, security rules) with zero warnings allowed          |
| `npm run typecheck`        | TypeScript type-check of source, tests and tooling config               |
| `npm run check`            | All local quality gates: format, lint, type-check, tests, build         |

### Database migrations

Migrations are plain SQL files in [src/db/migrations](src/db/migrations), named `NNNN_name.sql`
and applied in order. They are **forward-only and immutable once applied**: each applied file's
SHA-256 checksum is stored in `schema_migrations`, and the service refuses to start if an applied
migration was edited, removed or reordered. Change the schema by adding a new file.

Each migration runs in its own transaction, and a PostgreSQL advisory lock ensures only one
instance migrates at a time. The same runner is used by `npm run db:migrate` and by service
startup; inside the container you can also run `docker compose run --rm api node dist/db/migrate-cli.js`.

## Running the tests

| Kind        | Command                                       | Needs                         | What it proves                                                                                       |
| ----------- | --------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit        | `npm run test:unit`                           | Nothing                       | Pure rules, configuration, the HTTP contract with stubs, and the example client                      |
| Client unit | `npm run test:client`                         | Nothing                       | The example client's own behavior (subset of the unit tests)                                         |
| Integration | `npm run test:integration`                    | PostgreSQL (`_test` database) | Repositories, transactions, concurrency, isolation, pagination, API over real SQL                    |
| End to end  | `npm run test:e2e`                            | A running stack               | One complete example-client run shows every required behavior, exits 0 and prints no key             |
| Load        | `perf-smoke` / `perf-full` pull-request label | GitHub Actions                | Throughput, latency and invariants under load; results in [docs/performance.md](docs/performance.md) |

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
tests at it, for example `POSTGRES_HOST_PORT=15432` with the development-only Compose credentials:
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

1. `npm ci` with Node from `.nvmrc`, used only to check the client's output on the host.
2. Build the production image.
3. `docker compose down --volumes`, then `docker compose up --build`, so PostgreSQL, the service and
   the example client start from a fresh database volume (Compose starts the client only once the
   service is healthy); then check, without restarting anything, that PostgreSQL and the service
   are healthy.
4. Wait for the Compose `client` container to exit (at most 300 seconds) and require exit code 0.
   Its log is saved to a file and only a redacted copy is printed.
5. Run `npm run test:e2e` on that log: every step must appear in order, with the evidence of each
   required behavior (different plans, both rejection levels, the plan update, exact totals and
   remaining allowances, the complete history).
6. Check both health endpoints and that the service does not run as root.
7. Check that the client image runs as a non-root user, holds only the compiled client (no service
   source, no `node_modules`), and that the client container received no database setting.
8. Persistence: create an account, a user, an accepted and a rejected decision through the API,
   run `docker compose down` (which keeps the database volume) and `docker compose up --build`
   (which recreates every container, the example client running again), then require the
   account, user, usage and history responses to be byte-for-byte identical and the accepted
   request to replay its original response. The check's API key exists only in a temporary file
   that is removed when the step ends.
9. Fail if the API logs (before and after recreating the stack) or the client output contain
   anything API-key-shaped, the database password, or (API logs) an error-level entry.
10. Stop the API and require exit code 0 and a completed graceful shutdown.
11. On failure, print redacted Compose logs. Always run `docker compose down --volumes`. No
    artifacts are uploaded.

### Performance workflow

[.github/workflows/performance.yml](.github/workflows/performance.yml) runs the load tests only on
request: when a pull request gets the label `perf-smoke` (the pipeline at a small scale) or
`perf-full` (the measured protocol), or by manual dispatch once the workflow is on the default
branch. Ordinary pushes never start it. Requirements, commands and the evidence it uploads are
described in [docs/performance.md](docs/performance.md#reproducing-and-verifying).

## Known limitations

These are deliberate boundaries of the current implementation, not defects:

- **Per-account serialization.** Every decision of an account locks that account's monthly
  counter, so one account's decisions run one at a time. In the benchmark environment a single
  busy account completed about 158 requests per second; that figure describes that environment,
  not a limit of every deployment.
- **No service-level targets.** The specification defines none; the performance results are
  measurements, not commitments.
- **An unexplained measurement.** In the single-account stress runs one duplicate-request lookup
  took about 2.2 ms per call instead of under 0.3 ms. Its query plan was not captured, so no cause
  or optimization is claimed ([details](docs/performance.md#contention-diagnostics-and-the-per-account-capacity)).
- **Pagination of changing data.** Pages never repeat a row, and a traversal over unchanged data
  returns every row once. A row that commits after a traversal passed its position is missed by
  that traversal and included by the next one (a concurrent user creation, or two decisions of one
  account straddling a UTC month boundary).
- **Current-month usage cursors expire** when the UTC month changes; restart with `month=` to page
  through it as a past month.
- **Usage lists are not a snapshot.** Each page of `GET /v1/usage/users` reflects the moment it is
  served.
- **Cursors are opaque and filter-bound but not signed or encrypted.** They grant nothing: every
  lookup is restricted to the authenticated account in SQL.
- **No retention or deletion.** Decisions are kept indefinitely, and accounts, users, plans and keys
  cannot be deleted; there is no key rotation.
- **One database, no other coordination.** Several service instances can share one PostgreSQL
  (counters, uniqueness and migrations are coordinated in the database), but nothing else is
  distributed, and only one instance was load-tested.
- **Connection-pool exhaustion answers `500`.** A request that cannot get a database connection
  within `DB_CONNECTION_TIMEOUT_MS` receives the generic error rather than `503 BUSY_RETRY`. This
  was not reached in any benchmark run.
- **No metrics endpoint.** Operation is observed through structured JSON logs; there is no
  Prometheus-style endpoint, which the specification does not require.
- **The example client creates demonstration data.** Every run adds a new account with users and
  decisions, and nothing removes them except `docker compose down --volumes`.
