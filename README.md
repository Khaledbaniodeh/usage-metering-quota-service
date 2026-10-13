# Usage Metering and Quota Service

A backend service that other applications call to record usage and decide whether their users may
perform an action. Each account has a shared monthly allowance and each of its users has an
individual allowance; a request is accepted only when every applicable account and user rule allows
it.

## Status

**Implementation Phase 2: accounts, API keys and authentication.**

Implemented so far:

- Fastify 5 service with strictly validated configuration and request bodies, structured JSON
  logging with credential redaction, and graceful startup and shutdown.
- PostgreSQL schema for plans, accounts, users, monthly usage counters and the immutable decision
  history, created by a forward-only migration runner, plus the four predefined plans.
- Account creation with a one-time API key, X-API-Key authentication and the authenticated
  account endpoint.
- One catalogue of stable error codes behind a single JSON error shape.
- Liveness and readiness endpoints and generated OpenAPI documentation.
- Production Docker image and a Docker Compose stack (service + PostgreSQL).
- Unit tests, and integration tests against a real PostgreSQL database, including an
  account-isolation harness.

**Not implemented yet:** plan and user APIs, usage consumption, usage and history APIs, the example
client and load tests. They arrive in later, separately verified phases described in
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
curl -s -X POST http://127.0.0.1:8080/v1/accounts   -H "Content-Type: application/json"   -d '{"name": "Acme"}'
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

| Code                                                                        | HTTP     | Meaning                                                 |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------- |
| `VALIDATION_ERROR`, `BAD_REQUEST`                                           | 400      | The request is invalid or could not be parsed           |
| `UNAUTHORIZED`                                                              | 401      | A valid API key is required                             |
| `NOT_FOUND`                                                                 | 404      | The route or resource does not exist                    |
| `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PLAN_READ_ONLY`, `PLAN_SCOPE_MISMATCH` | 409      | The request conflicts with current state (later phases) |
| `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`                               | 413, 415 | The body is too large or not JSON                       |
| `BUSY_RETRY`, `SERVICE_UNAVAILABLE`                                         | 503      | Retry later (`BUSY_RETRY`) or the service is not ready  |
| `INTERNAL_ERROR`                                                            | 500      | Unexpected failure; no internal details are returned    |

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
