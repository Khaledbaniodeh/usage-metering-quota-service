import { rm } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../../../src/app/build-app.js";
import { loadMigrations } from "../../../../src/db/migrator.js";
import { createPool } from "../../../../src/db/pool.js";
import { createDatabaseReadinessCheck } from "../../../../src/db/readiness.js";
import { createSilentLogger } from "../../../helpers/logger.js";
import {
  copyProjectMigrations,
  type MigrationFixture,
} from "../../../helpers/migration-fixtures.js";
import {
  migrateTestDatabase,
  resetTestDatabase,
  testConfig,
  UNREACHABLE_DATABASE_URL,
  withTestClient,
} from "../../../helpers/test-database.js";

// Readiness against a real PostgreSQL database: no part of the database is mocked.

let app: App | undefined;
let pool: pg.Pool | undefined;
let fixture: MigrationFixture | undefined;

async function appFor(databaseUrl?: string): Promise<App> {
  const config = testConfig(databaseUrl);
  const logger = createSilentLogger();
  pool = createPool({ ...config.database, connectionTimeoutMs: 1_000 }, logger);
  app = await buildApp({
    logger,
    checkReadiness: createDatabaseReadinessCheck(pool, await loadMigrations(), logger),
  });
  return app;
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(async () => {
  await app?.close();
  await pool?.end();
  await fixture?.remove();
  app = undefined;
  pool = undefined;
  fixture = undefined;
});

describe("GET /health/ready with PostgreSQL", () => {
  it("returns 200 when the database is reachable and fully migrated", async () => {
    await migrateTestDatabase();
    const instance = await appFor();

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("returns 503 when the database has never been migrated", async () => {
    const instance = await appFor();

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Database migrations are not current" },
    });
  });

  it("returns 503 when only some migrations have been applied", async () => {
    fixture = await copyProjectMigrations();
    await rm(join(fixture.directory, "0002_predefined_plans.sql"));
    await migrateTestDatabase(fixture.directory);
    const instance = await appFor();

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "Database migrations are not current",
    );
  });

  it("returns 503 when an applied migration differs from the shipped one", async () => {
    await migrateTestDatabase();
    await withTestClient((client) =>
      client.query("UPDATE schema_migrations SET checksum = $1 WHERE name = $2", [
        "0".repeat(64),
        "0002_predefined_plans.sql",
      ]),
    );
    const instance = await appFor();

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 when the database is unreachable, while liveness stays 200", async () => {
    const instance = await appFor(UNREACHABLE_DATABASE_URL);

    const ready = await instance.inject({ method: "GET", url: "/health/ready" });
    const live = await instance.inject({ method: "GET", url: "/health/live" });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "The database is not reachable" },
    });
    expect(live.statusCode).toBe(200);
  });
});
