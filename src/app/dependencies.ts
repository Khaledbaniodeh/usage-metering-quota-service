import type pg from "pg";
import type { Logger } from "pino";
import type { Migration } from "../db/migrator.js";
import { createDatabaseReadinessCheck } from "../db/readiness.js";
import { findAccountIdByApiKeyHash } from "../modules/accounts/accounts.repository.js";
import { createAccountsService } from "../modules/accounts/accounts.service.js";
import type { RandomBytesSource } from "../modules/auth/api-key.js";
import { createConsumptionService } from "../modules/consumption/consume.service.js";
import { createPlansService } from "../modules/plans/plans.service.js";
import { createUsageService } from "../modules/usage/usage.service.js";
import { createUsersService } from "../modules/users/users.service.js";
import { systemClock, type Clock } from "../shared/clock.js";
import type { AppDependencies } from "./build-app.js";

/** Replaceable sources of time and randomness (tests pin them; production uses the defaults). */
export interface DependencyOverrides {
  readonly clock?: Clock;
  readonly randomBytes?: RandomBytesSource;
}

export interface DependencyOptions extends DependencyOverrides {
  /** Maximum wait for a quota-counter lock (DB_LOCK_TIMEOUT_MS). */
  readonly lockTimeoutMs: number;
}

/** The production wiring of every application service onto one database pool. */
export function createAppDependencies(
  pool: pg.Pool,
  migrations: readonly Migration[],
  logger: Logger,
  options: DependencyOptions,
): AppDependencies {
  const { lockTimeoutMs, ...overrides } = options;
  const clock = overrides.clock ?? systemClock;
  return {
    logger,
    checkReadiness: createDatabaseReadinessCheck(pool, migrations, logger),
    accounts: createAccountsService({
      db: pool,
      clock,
      ...(overrides.randomBytes === undefined ? {} : { randomBytes: overrides.randomBytes }),
    }),
    plans: createPlansService({ db: pool, clock }),
    users: createUsersService({ db: pool, clock }),
    consumption: createConsumptionService({ db: pool, clock, lockTimeoutMs }),
    usage: createUsageService({ db: pool, clock }),
    resolveAccountByApiKeyHash: async (apiKeyHash) => {
      const id = await findAccountIdByApiKeyHash(pool, apiKeyHash);
      return id === undefined ? undefined : { id };
    },
  };
}
