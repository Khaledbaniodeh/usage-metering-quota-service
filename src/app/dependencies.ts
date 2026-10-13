import type pg from "pg";
import type { Logger } from "pino";
import type { Migration } from "../db/migrator.js";
import { createDatabaseReadinessCheck } from "../db/readiness.js";
import { createAccountsService } from "../modules/accounts/accounts.service.js";
import type { RandomBytesSource } from "../modules/auth/api-key.js";
import { systemClock, type Clock } from "../shared/clock.js";
import type { AppDependencies } from "./build-app.js";

/** Replaceable sources of time and randomness (tests pin them; production uses the defaults). */
export interface DependencyOverrides {
  readonly clock?: Clock;
  readonly randomBytes?: RandomBytesSource;
}

/** The production wiring of every application service onto one database pool. */
export function createAppDependencies(
  pool: pg.Pool,
  migrations: readonly Migration[],
  logger: Logger,
  overrides: DependencyOverrides = {},
): AppDependencies {
  return {
    logger,
    checkReadiness: createDatabaseReadinessCheck(pool, migrations, logger),
    accounts: createAccountsService({
      db: pool,
      clock: overrides.clock ?? systemClock,
      ...(overrides.randomBytes === undefined ? {} : { randomBytes: overrides.randomBytes }),
    }),
  };
}
