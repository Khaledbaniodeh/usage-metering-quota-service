// Process entry point: configuration, logging, startup, signals and the shutdown deadline.
// Everything else (migrations, pool, application) lives behind startServer().

import { startServer } from "./app/server.js";
import { loadConfigOrReport } from "./config/config.js";
import { describeDatabaseTarget } from "./db/pool.js";
import { createLogger } from "./shared/logger.js";

async function main(): Promise<void> {
  const config = loadConfigOrReport(process.env, (message) => {
    process.stderr.write(`${message}\n`);
  });
  if (config === undefined) {
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  logger.info(
    { port: config.port, database: describeDatabaseTarget(config.database.url) },
    "starting usage-metering-quota-service",
  );

  let stop: () => Promise<void>;
  try {
    ({ stop } = await startServer(config, logger));
  } catch (error) {
    logger.fatal({ err: error }, "startup failed");
    process.exitCode = 1;
    return;
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "shutdown started");
    const deadline = setTimeout(() => {
      logger.fatal({ timeoutMs: config.shutdownTimeoutMs }, "graceful shutdown timed out");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();

    stop().then(
      () => {
        clearTimeout(deadline);
        logger.info("shutdown complete");
      },
      (error: unknown) => {
        clearTimeout(deadline);
        logger.error({ err: error }, "shutdown failed");
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await main();
