import type { Queryable } from "../../db/pool.js";
import type { Clock } from "../../shared/clock.js";
import { decodeCursor, encodeCursor, invalidCursor } from "../../shared/cursor.js";
import { AppError } from "../../shared/http-errors.js";
import { futureMonth } from "../../shared/query-params.js";
import { isFutureMonth, monthStartOf, utcMonthKey } from "../../shared/utc-month.js";
import { remainingAllowance } from "../consumption/consume.domain.js";
import { findUserSeq } from "../users/users.repository.js";
import { userNotFound } from "../users/users.service.js";
import {
  listUserUsagePage,
  readAccountUsage,
  readUserUsage,
  type UsageRow,
} from "./usage.repository.js";

/** Usage for one month: live limits and remaining units only for the current month. */
export type MonthlyUsage =
  | {
      readonly month: string;
      readonly used: number;
      readonly monthlyAllowance: number;
      readonly maxUnitsPerRequest: number;
      readonly remaining: number;
    }
  | { readonly month: string; readonly used: number };

/** A listed user in a current-month page: usage with the live plan and limits. */
export interface CurrentUserUsage {
  readonly userId: string;
  readonly name: string;
  readonly planId: string;
  readonly planName: string;
  readonly used: number;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly remaining: number;
}

/** A listed user in a past-month page: usage only. */
export interface PastUserUsage {
  readonly userId: string;
  readonly name: string;
  readonly used: number;
}

/** One page of the per-user usage list; the form is fixed for the whole traversal. */
export type UserUsagePage =
  | {
      readonly month: string;
      readonly currentMonth: true;
      readonly users: CurrentUserUsage[];
      readonly nextCursor: string | null;
    }
  | {
      readonly month: string;
      readonly currentMonth: false;
      readonly users: PastUserUsage[];
      readonly nextCursor: string | null;
    };

export interface UserUsagePageRequest {
  readonly month?: string | undefined;
  readonly cursor?: string | undefined;
  /** Validated page size (1-100). */
  readonly limit: number;
}

export interface UsageService {
  readonly getAccountUsage: (accountId: string, month?: string) => Promise<MonthlyUsage>;
  readonly getUserUsage: (
    accountId: string,
    userId: string,
    month?: string,
  ) => Promise<MonthlyUsage>;
  readonly listUserUsage: (
    accountId: string,
    request: UserUsagePageRequest,
  ) => Promise<UserUsagePage>;
}

export interface UsageServiceDependencies {
  readonly db: Queryable;
  readonly clock: Clock;
}

/** The requested month (default: the current UTC month) and whether it is the current one. */
export function resolveMonth(
  requested: string | undefined,
  now: Date,
): { readonly month: string; readonly isCurrent: boolean } {
  const current = utcMonthKey(now);
  if (requested === undefined) {
    return { month: current, isCurrent: true };
  }
  if (isFutureMonth(requested, now)) {
    throw futureMonth();
  }
  return { month: requested, isCurrent: requested === current };
}

/** The response form: a past month reports used only (its limits are on each decision). */
export function toMonthlyUsage(month: string, isCurrent: boolean, row: UsageRow): MonthlyUsage {
  if (!isCurrent) {
    return { month, used: row.used };
  }
  return {
    month,
    used: row.used,
    monthlyAllowance: row.monthlyAllowance,
    maxUnitsPerRequest: row.maxUnitsPerRequest,
    remaining: remainingAllowance(row.monthlyAllowance, row.used),
  };
}

/**
 * The month, form and start position of a per-user usage page. A cursor fixes the month and the
 * form for the whole traversal: a request may repeat the cursor's month but not change it, and a
 * traversal that began on the current month expires once that month is over, so a page never
 * changes form mid-traversal. Every cursor problem is the same 400 "Invalid cursor".
 */
async function resolveUserUsagePage(
  db: Queryable,
  accountId: string,
  request: UserUsagePageRequest,
  now: Date,
): Promise<{ month: string; isCurrent: boolean; beforeSeq: number | undefined }> {
  if (request.month !== undefined && isFutureMonth(request.month, now)) {
    throw futureMonth();
  }
  if (request.cursor === undefined) {
    return { ...resolveMonth(request.month, now), beforeSeq: undefined };
  }
  const cursor = decodeCursor("usage-users", request.cursor);
  const current = utcMonthKey(now);
  const usable =
    (request.month === undefined || request.month === cursor.month) &&
    cursor.month <= current &&
    cursor.currentMonth === (cursor.month === current);
  if (!usable) {
    throw invalidCursor();
  }
  const beforeSeq = await findUserSeq(db, accountId, cursor.anchor);
  if (beforeSeq === undefined) {
    throw invalidCursor();
  }
  return { month: cursor.month, isCurrent: cursor.currentMonth, beforeSeq };
}

export function createUsageService({ db, clock }: UsageServiceDependencies): UsageService {
  return {
    getAccountUsage: async (accountId, requested) => {
      const { month, isCurrent } = resolveMonth(requested, clock());
      const row = await readAccountUsage(db, accountId, monthStartOf(month));
      if (row === undefined) {
        throw new AppError("NOT_FOUND", "Account not found");
      }
      return toMonthlyUsage(month, isCurrent, row);
    },

    getUserUsage: async (accountId, userId, requested) => {
      const { month, isCurrent } = resolveMonth(requested, clock());
      const row = await readUserUsage(db, accountId, userId, monthStartOf(month));
      if (row === undefined) {
        throw userNotFound();
      }
      return toMonthlyUsage(month, isCurrent, row);
    },

    listUserUsage: async (accountId, request) => {
      const { month, isCurrent, beforeSeq } = await resolveUserUsagePage(
        db,
        accountId,
        request,
        clock(),
      );
      // One extra row tells whether another page exists.
      const rows = await listUserUsagePage(
        db,
        accountId,
        monthStartOf(month),
        beforeSeq,
        request.limit + 1,
      );
      const page = rows.slice(0, request.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > request.limit && last !== undefined
          ? encodeCursor({
              kind: "usage-users",
              anchor: last.userId,
              month,
              currentMonth: isCurrent,
            })
          : null;
      if (!isCurrent) {
        return {
          month,
          currentMonth: false,
          users: page.map((row) => ({ userId: row.userId, name: row.name, used: row.used })),
          nextCursor,
        };
      }
      return {
        month,
        currentMonth: true,
        users: page.map((row) => ({
          userId: row.userId,
          name: row.name,
          planId: row.planId,
          planName: row.planName,
          used: row.used,
          monthlyAllowance: row.monthlyAllowance,
          maxUnitsPerRequest: row.maxUnitsPerRequest,
          remaining: remainingAllowance(row.monthlyAllowance, row.used),
        })),
        nextCursor,
      };
    },
  };
}
