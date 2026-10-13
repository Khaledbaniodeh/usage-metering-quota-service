import type pg from "pg";
import type { Logger } from "pino";
import { buildApp, type App } from "../../src/app/build-app.js";
import { createAppDependencies, type DependencyOverrides } from "../../src/app/dependencies.js";
import { loadMigrations } from "../../src/db/migrator.js";
import { createPool } from "../../src/db/pool.js";
import { createSilentLogger } from "./logger.js";
import { testConfig } from "./test-database.js";

export interface IntegrationApp {
  readonly app: App;
  readonly pool: pg.Pool;
  readonly close: () => Promise<void>;
}

export interface IntegrationAppOptions extends DependencyOverrides {
  readonly logger?: Logger;
}

/**
 * The real application with the production wiring (createAppDependencies) on a pool connected to
 * the test database. Only time and randomness can be pinned. The caller migrates the database.
 */
export async function createIntegrationApp(
  options: IntegrationAppOptions = {},
): Promise<IntegrationApp> {
  const { logger = createSilentLogger(), ...overrides } = options;
  const pool = createPool(testConfig().database, logger);
  const app = await buildApp(
    createAppDependencies(pool, await loadMigrations(), logger, overrides),
  );
  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
