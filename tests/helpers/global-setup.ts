import { existsSync } from "node:fs";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { assertTestDatabaseName, databaseNameOf } from "./test-database-guard.js";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/**
 * Runs once before the integration tests: recreates the dedicated test database so every run
 * starts from a fresh, empty database, then hands its URL to the tests.
 *
 * TEST_DATABASE_URL comes from the environment (CI) or, locally, from an optional .env file.
 */
export default async function setup(project: TestProject): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests (see README: Running the tests)",
    );
  }

  const name = databaseNameOf(url);
  assertTestDatabaseName(name);
  await recreateDatabase(url, name);
  project.provide("testDatabaseUrl", url);
}

async function recreateDatabase(url: string, name: string): Promise<void> {
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    // Identifiers cannot be bound parameters; `name` matched the strict _test pattern above.
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}
