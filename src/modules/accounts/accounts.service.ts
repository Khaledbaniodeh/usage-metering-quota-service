import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db/pool.js";
import { isUniqueViolation } from "../../db/postgres-errors.js";
import type { Clock } from "../../shared/clock.js";
import { AppError } from "../../shared/http-errors.js";
import { generateApiKey, hashApiKey, type RandomBytesSource } from "../auth/api-key.js";
import {
  API_KEY_HASH_CONSTRAINT,
  findAccountById,
  insertAccountWithPredefinedPlan,
  type AccountRecord,
} from "./accounts.repository.js";

/** Every new account starts on this predefined account plan. */
export const DEFAULT_ACCOUNT_PLAN_CODE = "starter";

/**
 * Two keys sharing a SHA-256 digest is practically impossible (2^-256 per pair), but if the unique
 * constraint ever rejects a digest, a fresh key is generated instead of failing the request.
 */
export const MAX_API_KEY_ATTEMPTS = 3;

export interface CreatedAccount {
  readonly account: AccountRecord;
  /** The raw API key: returned to the caller once and never stored. */
  readonly apiKey: string;
}

export interface AccountsService {
  readonly createAccount: (name: string) => Promise<CreatedAccount>;
  readonly getAccount: (accountId: string) => Promise<AccountRecord>;
}

export interface AccountsServiceDependencies {
  readonly db: Queryable;
  readonly clock: Clock;
  readonly randomBytes?: RandomBytesSource;
}

export function createAccountsService(dependencies: AccountsServiceDependencies): AccountsService {
  const { db, clock, randomBytes } = dependencies;

  const createAccount = async (name: string): Promise<CreatedAccount> => {
    const now = clock();
    const id = randomUUID();

    for (let attempt = 1; ; attempt += 1) {
      const apiKey = generateApiKey(randomBytes);
      try {
        const account = await insertAccountWithPredefinedPlan(db, {
          id,
          name,
          apiKeyHash: hashApiKey(apiKey),
          planCode: DEFAULT_ACCOUNT_PLAN_CODE,
          now,
        });
        if (account === undefined) {
          throw new Error(
            `The predefined account plan "${DEFAULT_ACCOUNT_PLAN_CODE}" is missing; migrations are incomplete`,
          );
        }
        return { account, apiKey };
      } catch (error) {
        if (!isUniqueViolation(error, API_KEY_HASH_CONSTRAINT)) {
          throw error;
        }
        if (attempt >= MAX_API_KEY_ATTEMPTS) {
          throw new Error(
            `Could not generate a unique API key after ${String(MAX_API_KEY_ATTEMPTS)} attempts`,
            { cause: error },
          );
        }
      }
    }
  };

  const getAccount = async (accountId: string): Promise<AccountRecord> => {
    const account = await findAccountById(db, accountId);
    if (account === undefined) {
      throw new AppError("NOT_FOUND", "Account not found");
    }
    return account;
  };

  return { createAccount, getAccount };
}
