import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db/pool.js";
import type { Clock } from "../../shared/clock.js";
import { decodeCursor, encodeCursor, invalidCursor } from "../../shared/cursor.js";
import { AppError } from "../../shared/http-errors.js";
import { assignedOrThrow } from "../plans/plan-assignment.js";
import {
  assignUserPlan,
  findUser,
  findUserSeq,
  insertUserWithPredefinedPlan,
  listUsersPage,
  type UserRecord,
} from "./users.repository.js";

/** Every new user starts on this predefined user plan. */
export const DEFAULT_USER_PLAN_CODE = "basic";

export interface UsersService {
  readonly createUser: (accountId: string, name: string) => Promise<UserRecord>;
  readonly getUser: (accountId: string, userId: string) => Promise<UserRecord>;
  readonly listUsers: (accountId: string, page: PageRequest) => Promise<UserPage>;
  readonly assignPlan: (accountId: string, userId: string, planId: string) => Promise<UserRecord>;
}

export interface PageRequest {
  /** Validated page size (1-100). */
  readonly limit: number;
  /** Raw cursor from the query string, decoded and checked here. */
  readonly cursor?: string | undefined;
}

export interface UserPage {
  readonly users: UserRecord[];
  readonly nextCursor: string | null;
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

    listUsers: async (accountId, { limit, cursor }) => {
      let afterSeq: number | undefined;
      if (cursor !== undefined) {
        const { anchor } = decodeCursor("users", cursor);
        afterSeq = await findUserSeq(db, accountId, anchor);
        if (afterSeq === undefined) {
          throw invalidCursor();
        }
      }
      // One extra row tells whether another page exists.
      const rows = await listUsersPage(db, accountId, afterSeq, limit + 1);
      const users = rows.slice(0, limit);
      const last = users.at(-1);
      return {
        users,
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor({ kind: "users", anchor: last.id })
            : null,
      };
    },

    assignPlan: async (accountId, userId, planId) =>
      assignedOrThrow(await assignUserPlan(db, accountId, userId, planId, clock()), userNotFound),
  };
}
