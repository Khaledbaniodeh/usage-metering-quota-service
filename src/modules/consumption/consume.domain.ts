/**
 * Pure quota rules: no database, clock or HTTP access. Everything here is a function of its
 * arguments, so every rule, boundary and response field can be tested exhaustively in isolation.
 */

import { toMonthKey } from "../../shared/utc-month.js";

/** The UTC month helpers are shared; they are re-exported here for the consume workflow. */
export { toMonthKey, utcMonthStart } from "../../shared/utc-month.js";

export const QUOTA_RULES = ["MAX_UNITS_PER_REQUEST", "MONTHLY_ALLOWANCE"] as const;
export type QuotaRule = (typeof QUOTA_RULES)[number];

export const QUOTA_LEVELS = ["ACCOUNT", "USER"] as const;
export type QuotaLevel = (typeof QUOTA_LEVELS)[number];

/** The limits of one plan and the usage already counted against it this month. */
export interface QuotaPosition {
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly usedBefore: number;
}

export interface QuotaInput {
  readonly units: number;
  readonly account: QuotaPosition;
  readonly user: QuotaPosition;
}

export type QuotaEvaluation =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly blockingRule: QuotaRule;
      readonly blockingLevel: QuotaLevel;
    };

interface RuleCheck {
  readonly rule: QuotaRule;
  readonly level: QuotaLevel;
  readonly violated: (input: QuotaInput) => boolean;
}

/**
 * The four checks in their fixed evaluation order. The first violated check is reported, so a
 * request that breaks several rules always names the same one.
 */
export const RULE_ORDER: readonly RuleCheck[] = [
  {
    rule: "MAX_UNITS_PER_REQUEST",
    level: "USER",
    violated: ({ units, user }) => units > user.maxUnitsPerRequest,
  },
  {
    rule: "MAX_UNITS_PER_REQUEST",
    level: "ACCOUNT",
    violated: ({ units, account }) => units > account.maxUnitsPerRequest,
  },
  {
    rule: "MONTHLY_ALLOWANCE",
    level: "USER",
    violated: ({ units, user }) => user.usedBefore + units > user.monthlyAllowance,
  },
  {
    rule: "MONTHLY_ALLOWANCE",
    level: "ACCOUNT",
    violated: ({ units, account }) => account.usedBefore + units > account.monthlyAllowance,
  },
];

/** Accepts the full amount only when all four limits allow it; otherwise names the first rule. */
export function evaluateQuota(input: QuotaInput): QuotaEvaluation {
  const failed = RULE_ORDER.find((check) => check.violated(input));
  return failed === undefined
    ? { accepted: true }
    : { accepted: false, blockingRule: failed.rule, blockingLevel: failed.level };
}

/** Units still available; zero (never negative) when an allowance was reduced below usage. */
export function remainingAllowance(monthlyAllowance: number, used: number): number {
  return Math.max(0, monthlyAllowance - used);
}

/** The plan snapshot and usage of one level, exactly as recorded with the decision. */
export interface DecisionLevelSnapshot {
  readonly planId: string;
  readonly planName: string;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly usedBefore: number;
}

/** A stored consume decision: the immutable record every response is built from. */
export interface ConsumeDecision {
  readonly requestId: string;
  readonly userId: string;
  readonly units: number;
  readonly accepted: boolean;
  readonly blockingRule: QuotaRule | null;
  readonly blockingLevel: QuotaLevel | null;
  /** First day of the UTC month (`YYYY-MM-DD`) the decision was counted in. */
  readonly month: string;
  readonly processedAt: Date;
  readonly account: DecisionLevelSnapshot;
  readonly user: DecisionLevelSnapshot;
}

export interface DecisionLevelResponse {
  readonly planId: string;
  readonly planName: string;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  /** Usage of the month after this decision. */
  readonly used: number;
  readonly remaining: number;
}

export interface ConsumeDecisionResponse {
  readonly requestId: string;
  readonly userId: string;
  readonly units: number;
  readonly accepted: boolean;
  readonly blockingRule: QuotaRule | null;
  readonly blockingLevel: QuotaLevel | null;
  /** `YYYY-MM` (UTC). */
  readonly month: string;
  readonly processedAt: string;
  readonly account: DecisionLevelResponse;
  readonly user: DecisionLevelResponse;
}

/**
 * The single builder of consume responses. It reads only the stored decision, so the original
 * response and every replay of it are identical, whatever happened to plans or counters since.
 */
export function toDecisionResponse(decision: ConsumeDecision): ConsumeDecisionResponse {
  const counted = decision.accepted ? decision.units : 0;
  const level = (snapshot: DecisionLevelSnapshot): DecisionLevelResponse => {
    const used = snapshot.usedBefore + counted;
    return {
      planId: snapshot.planId,
      planName: snapshot.planName,
      monthlyAllowance: snapshot.monthlyAllowance,
      maxUnitsPerRequest: snapshot.maxUnitsPerRequest,
      used,
      remaining: remainingAllowance(snapshot.monthlyAllowance, used),
    };
  };
  return {
    requestId: decision.requestId,
    userId: decision.userId,
    units: decision.units,
    accepted: decision.accepted,
    blockingRule: decision.blockingRule,
    blockingLevel: decision.blockingLevel,
    month: toMonthKey(decision.month),
    processedAt: decision.processedAt.toISOString(),
    account: level(decision.account),
    user: level(decision.user),
  };
}

/** The request fields that determine a decision; a retry must repeat all of them exactly. */
export interface ConsumePayload {
  readonly userId: string;
  readonly units: number;
}

/** Whether a stored decision was made for exactly this payload (same request ID assumed). */
export function isSamePayload(decision: ConsumeDecision, payload: ConsumePayload): boolean {
  return decision.userId === payload.userId && decision.units === payload.units;
}
