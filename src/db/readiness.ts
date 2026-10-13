import type pg from "pg";
import type { Logger } from "pino";
import type { ReadinessCheck } from "../modules/health/health.routes.js";
import { getMigrationStatus, type Migration } from "./migrator.js";

/**
 * Readiness = PostgreSQL answers a query through the application pool AND the applied migrations
 * are exactly the migrations shipped with this build. The check is a single small read of
 * schema_migrations, bounded by the pool's connection and statement timeouts.
 */
export function createDatabaseReadinessCheck(
  pool: pg.Pool,
  expectedMigrations: readonly Migration[],
  logger: Logger,
): ReadinessCheck {
  return async () => {
    try {
      const status = await getMigrationStatus(pool, expectedMigrations);
      return status.state === "current"
        ? { ready: true }
        : { ready: false, reason: "MIGRATIONS_NOT_CURRENT" };
    } catch (error) {
      logger.warn({ err: error }, "database readiness query failed");
      return { ready: false, reason: "DATABASE_UNAVAILABLE" };
    }
  };
}
