import { isDeepStrictEqual } from "node:util";
import type { Decision, MonthlyUsage, Plan, User, UserUsage } from "./api-types.js";

/**
 * The example workflow's domain assertions. Failure messages carry only safe values from the
 * responses being checked (IDs, counts, codes), shortened to stay concise.
 */

export class CheckFailed extends Error {
  override readonly name: string = "CheckFailed";
}

/**
 * A response used the other month form (current vs past). After a UTC month change during a run
 * that is expected, so the workflow re-checks the current month before reporting it.
 */
export class FormMismatch extends CheckFailed {
  override readonly name = "FormMismatch";
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new CheckFailed(message);
  }
}

/** A value for a failure message, shortened so messages stay concise. */
function brief(value: unknown): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function checkEqual(actual: unknown, expected: unknown, what: string): void {
  check(
    isDeepStrictEqual(actual, expected),
    `${what}: expected ${brief(expected)}, got ${brief(actual)}`,
  );
}

/** Current month: usage with the live plan's limits. Past month: usage only. */
export type UsageForm = "current" | "past";

interface LiveLimits {
  readonly monthlyAllowance?: number | undefined;
  readonly maxUnitsPerRequest?: number | undefined;
  readonly remaining?: number | undefined;
}

/** The form of a usage value: all three live fields, or none. Anything in between fails. */
export function usageForm(value: LiveLimits, what: string): UsageForm {
  const present = [value.monthlyAllowance, value.maxUnitsPerRequest, value.remaining].filter(
    (field) => field !== undefined,
  ).length;
  if (present === 3) {
    return "current";
  }
  if (present === 0) {
    return "past";
  }
  throw new CheckFailed(
    `${what}: monthlyAllowance, maxUnitsPerRequest and remaining must be all present or all absent (${String(present)} of 3 present)`,
  );
}

export function checkForm(actual: UsageForm, expected: UsageForm, what: string): void {
  if (actual !== expected) {
    throw new FormMismatch(
      `${what}: expected the ${expected}-month form, got the ${actual}-month form`,
    );
  }
}

function checkLiveLimits(value: LiveLimits, plan: Plan, used: number, what: string): void {
  checkEqual(
    [value.monthlyAllowance, value.maxUnitsPerRequest, value.remaining],
    [plan.monthlyAllowance, plan.maxUnitsPerRequest, Math.max(0, plan.monthlyAllowance - used)],
    `${what} [monthlyAllowance, maxUnitsPerRequest, remaining]`,
  );
}

export interface UsageExpectation {
  readonly month: string;
  readonly used: number;
  /** The plan whose limits the current-month form must show. */
  readonly plan: Plan;
  readonly form: UsageForm;
}

/** GET /v1/usage and GET /v1/users/{userId}/usage. */
export function checkMonthlyUsage(
  usage: MonthlyUsage,
  expected: UsageExpectation,
  what: string,
): void {
  checkEqual([usage.month, usage.used], [expected.month, expected.used], `${what} [month, used]`);
  checkForm(usageForm(usage, what), expected.form, what);
  if (expected.form === "current") {
    checkLiveLimits(usage, expected.plan, expected.used, what);
  }
}

/** One item of GET /v1/usage/users. */
export function checkListedUsage(
  item: UserUsage,
  expected: { readonly user: User; readonly used: number; readonly form: UsageForm },
  what: string,
): void {
  const { user, used } = expected;
  checkEqual(
    [item.userId, item.name, item.used],
    [user.id, user.name, used],
    `${what} [userId, name, used]`,
  );
  const form = usageForm(item, what);
  const planFields = [item.planId, item.planName].filter((field) => field !== undefined).length;
  check(
    planFields === (form === "current" ? 2 : 0),
    `${what}: planId and planName must be present exactly when the live limits are`,
  );
  checkForm(form, expected.form, what);
  if (form === "current") {
    checkEqual([item.planId, item.planName], [user.plan.id, user.plan.name], `${what} plan`);
    checkLiveLimits(item, user.plan, used, what);
  }
}

export interface DecisionExpectation {
  readonly requestId: string;
  readonly userId: string;
  readonly units: number;
  readonly accepted: boolean;
  readonly blockingRule: Decision["blockingRule"];
  readonly blockingLevel: Decision["blockingLevel"];
  /** The user's and the account's usage after the decision. */
  readonly userUsed: number;
  readonly accountUsed: number;
}

/** A POST /v1/consume decision: echoed request, outcome and usage after it. */
export function checkDecision(decision: Decision, expected: DecisionExpectation): void {
  const what = `decision ${expected.requestId}`;
  checkEqual(
    [decision.requestId, decision.userId, decision.units],
    [expected.requestId, expected.userId, expected.units],
    `${what} [requestId, userId, units]`,
  );
  checkEqual(
    [decision.accepted, decision.blockingRule, decision.blockingLevel],
    [expected.accepted, expected.blockingRule, expected.blockingLevel],
    `${what} outcome`,
  );
  checkEqual(
    [decision.user.used, decision.account.used],
    [expected.userUsed, expected.accountUsed],
    `${what} [user used, account used]`,
  );
}
