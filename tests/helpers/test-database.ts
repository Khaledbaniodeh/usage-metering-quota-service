import pg from "pg";
import { inject } from "vitest";
import type { AppConfig } from "../../src/config/config.js";
import { loadMigrations, migrateDatabase } from "../../src/db/migrator.js";
import { typeParsers } from "../../src/db/type-parsers.js";
import { createSilentLogger } from "./logger.js";
import { assertTestDatabaseName } from "./test-database-guard.js";

/** URL of the dedicated test database prepared by global-setup.ts. */
export function testDatabaseUrl(): string {
  return inject("testDatabaseUrl");
}

/** A URL that points at a port where nothing listens, for "database unavailable" scenarios. */
export const UNREACHABLE_DATABASE_URL =
  "postgres://usage_metering:unused@127.0.0.1:1/unreachable_test";

export function testConfig(databaseUrl: string = testDatabaseUrl()): AppConfig {
  return {
    port: 0,
    logLevel: "silent",
    shutdownTimeoutMs: 5_000,
    database: {
      url: databaseUrl,
      poolMax: 5,
      connectionTimeoutMs: 2_000,
      statementTimeoutMs: 5_000,
    },
  };
}

export async function withTestClient<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), types: typeParsers });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Removes every table, type and function from the test database (refuses non-_test databases). */
export async function resetTestDatabase(): Promise<void> {
  await withTestClient(async (client) => {
    const result = await client.query<{ name: string }>("SELECT current_database() AS name");
    assertTestDatabaseName(result.rows[0]?.name ?? "");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
}

/** Applies the project's migrations to the test database. */
export async function migrateTestDatabase(directory?: string): Promise<readonly string[]> {
  const { applied } = await migrateDatabase({
    connectionString: testDatabaseUrl(),
    connectionTimeoutMs: 2_000,
    migrations: await loadMigrations(directory),
    logger: createSilentLogger(),
  });
  return applied;
}
