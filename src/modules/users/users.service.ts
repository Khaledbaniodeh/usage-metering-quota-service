import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db/pool.js";
import type { Clock } from "../../shared/clock.js";
import { AppError } from "../../shared/http-errors.js";
import {
  findUser,
  insertUserWithPredefinedPlan,
  listUsers,
  type UserRecord,
} from "./users.repository.js";

/** Every new user starts on this predefined user plan. */
export const DEFAULT_USER_PLAN_CODE = "basic";

export interface UsersService {
  readonly createUser: (accountId: string, name: string) => Promise<UserRecord>;
  readonly getUser: (accountId: string, userId: string) => Promise<UserRecord>;
  readonly listUsers: (accountId: string) => Promise<UserRecord[]>;
}

export interface UsersServiceDependencies {
  readonly db: Queryable;
  readonly clock: Clock;
}

/** Unknown users and other accounts' users get this same error, so neither can be detected. */
export function userNotFound(): AppError {
  return new AppError("NOT_FOUND", "User not found");
}

export function createUsersService({ db, clock }: UsersServiceDependencies): UsersService {
  return {
    createUser: async (accountId, name) => {
      const user = await insertUserWithPredefinedPlan(db, {
        id: randomUUID(),
        accountId,
        name,
        planCode: DEFAULT_USER_PLAN_CODE,
        now: clock(),
      });
      if (user === undefined) {
        throw new Error(
          `The predefined user plan "${DEFAULT_USER_PLAN_CODE}" is missing; migrations are incomplete`,
        );
      }
      return user;
    },

    getUser: async (accountId, userId) => {
      const user = await findUser(db, accountId, userId);
      if (user === undefined) {
        throw userNotFound();
      }
      return user;
    },

    listUsers: (accountId) => listUsers(db, accountId),
  };
}
