# Usage Metering and Quota Service

A backend service that other applications call to record usage and decide whether their users may
perform an action. Each account has a shared monthly allowance and each of its users has an
individual allowance; a request is accepted only when every applicable account and user rule allows
it.

## Status

**Implementation Phase 1: infrastructure and database foundation.**

Implemented so far:

- Fastify 5 service with strictly validated configuration, structured JSON logging with credential
  redaction, and graceful startup and shutdown.
- PostgreSQL schema for plans, accounts, users, monthly usage counters and the immutable decision
  history, created by a forward-only migration runner, plus the four predefined plans.
- Liveness and readiness endpoints and generated OpenAPI documentation.
- Production Docker image and a Docker Compose stack (service + PostgreSQL).
- Unit tests and integration tests against a real PostgreSQL database.

**Not implemented yet:** API keys and authentication, account, plan and user APIs, usage
consumption, usage and history APIs, the example client and load tests. They arrive in later,
separately verified phases described in [docs/architecture.md](docs/architecture.md). The service
does not offer any business endpoint yet.

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

Test database safety:

- The test run **drops and recreates** the database named in `TEST_DATABASE_URL`, and tests reset
  its schema between cases. Every helper that does this refuses to touch a database whose name does
  not end in `_test`, so a development or production database cannot be wiped by mistake.
- The test database is created automatically through the server's `postgres` maintenance
  database, so the configured user needs permission to create databases (the Compose user has it).

CI runs the same suite against a PostgreSQL 16 service container, and separately builds the Docker
image, starts the Compose stack and checks health, user, logs and graceful shutdown.
