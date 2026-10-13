import pg from "pg";
import type { Logger } from "pino";
import type { DatabaseConfig } from "../config/config.js";
import { typeParsers } from "./type-parsers.js";

export const APPLICATION_NAME = "usage-metering-quota-service";

/** Closes idle connections after this long so the pool shrinks when traffic drops. */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Creates the application's connection pool. Every connection has a bounded statement timeout and
 * the explicit type conversions from type-parsers.ts. Errors on idle connections (for example a
 * database restart) are logged instead of crashing the process.
 */
export function createPool(config: DatabaseConfig, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.url,
    application_name: APPLICATION_NAME,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: config.statementTimeoutMs,
    types: typeParsers,
  });
  pool.on("error", (error) => {
    logger.error({ err: error }, "PostgreSQL error on an idle pooled connection");
  });
  return pool;
}

export interface DatabaseTarget {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

/** The parts of a database URL that are safe to log: never the user name or password. */
export function describeDatabaseTarget(url: string): DatabaseTarget {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? "5432" : parsed.port,
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
}

/** Anything that can run a query: the pool, a pooled client or a dedicated client. */
export type Queryable = Pick<pg.ClientBase, "query">;
