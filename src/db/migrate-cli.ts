// Command-line entry point that applies pending migrations and exits. It runs exactly the same
// migration code as application startup.

import { loadConfigOrReport } from "../config/config.js";
import { createLogger } from "../shared/logger.js";
import { loadMigrations, migrateDatabase } from "./migrator.js";
import { describeDatabaseTarget } from "./pool.js";

async function runMigrationCli(): Promise<number> {
  const config = loadConfigOrReport(process.env, (message) => {
    process.stderr.write(`${message}\n`);
  });
  if (config === undefined) {
    return 1;
  }

  const logger = createLogger(config.logLevel);
  try {
    const migrations = await loadMigrations();
    const { applied } = await migrateDatabase({
      connectionString: config.database.url,
      connectionTimeoutMs: config.database.connectionTimeoutMs,
      migrations,
      logger,
    });
    logger.info(
      {
        database: describeDatabaseTarget(config.database.url),
        appliedNow: applied,
        total: migrations.length,
      },
      applied.length === 0 ? "database schema was already up to date" : "migrations applied",
    );
    return 0;
  } catch (error) {
    logger.fatal({ err: error }, "migration failed");
    return 1;
  }
}

process.exitCode = await runMigrationCli();
