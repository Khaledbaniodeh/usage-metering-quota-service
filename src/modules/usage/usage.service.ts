import type { Queryable } from "../../db/pool.js";
import type { Clock } from "../../shared/clock.js";
import { AppError } from "../../shared/http-errors.js";
import { isFutureMonth, monthStartOf, utcMonthKey } from "../../shared/utc-month.js";
import { remainingAllowance } from "../consumption/consume.domain.js";
import { userNotFound } from "../users/users.service.js";
import { readAccountUsage, readUserUsage, type UsageRow } from "./usage.repository.js";

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

export interface UsageService {
  readonly getAccountUsage: (accountId: string, month?: string) => Promise<MonthlyUsage>;
  readonly getUserUsage: (
    accountId: string,
    userId: string,
    month?: string,
  ) => Promise<MonthlyUsage>;
}

export interface UsageServiceDependencies {
  readonly db: Queryable;
  readonly clock: Clock;
}

export function futureMonth(): AppError {
  return new AppError("VALIDATION_ERROR", "month must not be in the future");
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
  };
}
