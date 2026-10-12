import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getMigrationStatus,
  loadMigrations,
  migrateDatabase,
  MIGRATION_LOCK_KEY,
  MigrationError,
  type MigrateOptions,
} from "../../../src/db/migrator.js";
import { createSilentLogger } from "../../helpers/logger.js";
import { copyProjectMigrations, type MigrationFixture } from "../../helpers/migration-fixtures.js";
import {
  resetTestDatabase,
  testDatabaseUrl,
  UNREACHABLE_DATABASE_URL,
  withTestClient,
} from "../../helpers/test-database.js";

const PROJECT_MIGRATIONS = ["0001_baseline_schema.sql", "0002_predefined_plans.sql"];

let fixture: MigrationFixture | undefined;

async function options(directory?: string): Promise<MigrateOptions> {
  return {
    connectionString: testDatabaseUrl(),
    connectionTimeoutMs: 2_000,
    migrations: await loadMigrations(directory),
    logger: createSilentLogger(),
  };
}

async function appliedRows(): Promise<{ name: string; checksum: string; applied_at: Date }[]> {
  return withTestClient(async (client) => {
    const result = await client.query<{ name: string; checksum: string; applied_at: Date }>(
      "SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name",
    );
    return result.rows;
  });
}

async function tableExists(name: string): Promise<boolean> {
  return withTestClient(async (client) => {
    const result = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [name],
    );
    return result.rows[0]?.exists === true;
  });
}

async function migrationLockIsFree(): Promise<boolean> {
  return withTestClient(async (client) => {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [MIGRATION_LOCK_KEY],
    );
    if (result.rows[0]?.acquired === true) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
      return true;
    }
    return false;
  });
}

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(async () => {
  await fixture?.remove();
  fixture = undefined;
});

describe("migrateDatabase", () => {
  it("migrates an empty database and records name, checksum and time of each migration", async () => {
    const migrateOptions = await options();

    const result = await migrateDatabase(migrateOptions);

    expect(result.applied).toEqual(PROJECT_MIGRATIONS);
    const rows = await appliedRows();
    expect(rows.map(({ name, checksum }) => ({ name, checksum }))).toEqual(
      migrateOptions.migrations.map(({ name, checksum }) => ({ name, checksum })),
    );
    for (const row of rows) {
      expect(row.applied_at).toBeInstanceOf(Date);
    }
    const status = await withTestClient((client) =>
      getMigrationStatus(client, migrateOptions.migrations),
    );
    expect(status).toEqual({ state: "current" });
  });

  it("is a no-op when run again", async () => {
    await migrateDatabase(await options());
    const before = await appliedRows();

    const second = await migrateDatabase(await options());

    expect(second.applied).toEqual([]);
    expect(await appliedRows()).toEqual(before);
  });

  it("applies each migration exactly once when several instances start concurrently", async () => {
    const migrateOptions = await options();

    const results = await Promise.all([
      migrateDatabase(migrateOptions),
      migrateDatabase(migrateOptions),
      migrateDatabase(migrateOptions),
    ]);

    expect(results.flatMap((result) => result.applied).sort()).toEqual(PROJECT_MIGRATIONS);
    expect(await appliedRows()).toHaveLength(PROJECT_MIGRATIONS.length);
    expect(await migrationLockIsFree()).toBe(true);
  });

  it("detects an applied migration that was modified, without changing the database", async () => {
    fixture = await copyProjectMigrations();
    await migrateDatabase(await options(fixture.directory));
    const before = await appliedRows();
    await appendFile(join(fixture.directory, "0001_baseline_schema.sql"), "\n-- edited\n");

    const run = migrateDatabase(await options(fixture.directory));

    await expect(run).rejects.toThrow(MigrationError);
    await expect(run).rejects.toThrow(
      "Migration 0001_baseline_schema.sql was modified after it was applied",
    );
    expect(await appliedRows()).toEqual(before);
    expect(await migrationLockIsFree()).toBe(true);
  });

  it("rolls back a failing migration completely and can recover once it is fixed", async () => {
    fixture = await copyProjectMigrations();
    await fixture.write(
      "0003_broken.sql",
      "CREATE TABLE half_applied (id integer);\nSELECT * FROM table_that_does_not_exist;\n",
    );

    await expect(migrateDatabase(await options(fixture.directory))).rejects.toThrow(
      "Migration 0003_broken.sql failed and was rolled back",
    );

    expect(await tableExists("half_applied")).toBe(false);
    expect((await appliedRows()).map((row) => row.name)).toEqual(PROJECT_MIGRATIONS);
    expect(await migrationLockIsFree()).toBe(true);

    await fixture.write("0003_broken.sql", "CREATE TABLE half_applied (id integer);\n");
    const recovered = await migrateDatabase(await options(fixture.directory));
    expect(recovered.applied).toEqual(["0003_broken.sql"]);
    expect(await tableExists("half_applied")).toBe(true);
  });

  it("refuses to run when the database contains a migration this build does not ship", async () => {
    fixture = await copyProjectMigrations();
    await fixture.write("0003_future.sql", "CREATE TABLE future_feature (id integer);\n");
    await migrateDatabase(await options(fixture.directory));

    await expect(migrateDatabase(await options())).rejects.toThrow(
      "The database has 3 applied migrations but this build only knows 2",
    );
  });

  it("waits for the advisory lock and gives up after the lock timeout", async () => {
    const holder = new pg.Client({ connectionString: testDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);

      const run = migrateDatabase({ ...(await options()), lockTimeoutMs: 300 });

      await expect(run).rejects.toThrow("canceling statement due to lock timeout");
      expect(await tableExists("schema_migrations")).toBe(false);
    } finally {
      await holder.end();
    }
    expect((await migrateDatabase(await options())).applied).toEqual(PROJECT_MIGRATIONS);
  });

  it("fails clearly when the database is unreachable", async () => {
    const run = migrateDatabase({
      ...(await options()),
      connectionString: UNREACHABLE_DATABASE_URL,
      connectionTimeoutMs: 1_000,
    });

    await expect(run).rejects.toThrow();
  });
});
