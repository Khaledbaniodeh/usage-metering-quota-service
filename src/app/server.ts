import type pg from "pg";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import { loadMigrations, migrateDatabase } from "../db/migrator.js";
import { createPool } from "../db/pool.js";
import { buildApp, type App } from "./build-app.js";
import { createAppDependencies } from "./dependencies.js";

/** The service always listens on every interface inside its container or host. */
export const LISTEN_HOST = "0.0.0.0";

export interface RunningServer {
  readonly app: App;
  readonly pool: pg.Pool;
  /** Address reported by Fastify once listening. */
  readonly address: string;
  /** Stops accepting requests, waits for in-flight requests, then closes the pool. Idempotent. */
  readonly stop: () => Promise<void>;
}

export interface StartServerOptions {
  /** Overrides the bundled migrations directory (used by tests). */
  readonly migrationsDirectory?: string;
}

/**
 * Starts the service: applies pending migrations (fatal on failure), opens the connection pool,
 * builds the application and starts listening. Anything created before a failure is closed again,
 * and the error is rethrown for the entry point to report.
 */
export async function startServer(
  config: AppConfig,
  logger: Logger,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const migrations = await loadMigrations(options.migrationsDirectory);
  const { applied } = await migrateDatabase({
    connectionString: config.database.url,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    migrations,
    logger,
  });
  logger.info({ appliedNow: applied, total: migrations.length }, "database schema is up to date");

  const pool = createPool(config.database, logger);
  let app: App | undefined;
  try {
    app = await buildApp(
      createAppDependencies(pool, migrations, logger, {
        lockTimeoutMs: config.database.lockTimeoutMs,
      }),
    );
    const address = await app.listen({ host: LISTEN_HOST, port: config.port });
    return { app, pool, address, stop: onceAsync(stopAll(app, pool)) };
  } catch (error) {
    await app?.close();
    await pool.end();
    throw error;
  }
}

function stopAll(app: App, pool: pg.Pool): () => Promise<void> {
  return async () => {
    try {
      await app.close();
    } finally {
      await pool.end();
    }
  };
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => (result ??= operation());
}
