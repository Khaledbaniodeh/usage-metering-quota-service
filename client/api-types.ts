/**
 * Response shapes of the public HTTP API, as documented in the README and the OpenAPI document
 * (/docs). Written independently of the service's source: the client knows only the public
 * contract.
 */

export type PlanScope = "ACCOUNT" | "USER";

export interface Plan {
  readonly id: string;
  /** Set for predefined plans (`starter`, `pro`, `basic`, `premium`); null for custom plans. */
  readonly code: string | null;
  readonly name: string;
  readonly scope: PlanScope;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

/** A plan as a resource of its own (GET/POST /v1/plans, PATCH /v1/plans/{planId}). */
export interface PlanResource extends Plan {
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Predefined plans first, then the account's own custom plans. */
export interface PlanList {
  readonly plans: readonly PlanResource[];
}

export interface CreatePlanRequest {
  readonly name: string;
  readonly scope: PlanScope;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

/** At least one field; scope, owner and code never change. */
export interface UpdatePlanRequest {
  readonly name?: string;
  readonly monthlyAllowance?: number;
  readonly maxUnitsPerRequest?: number;
}

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly plan: Plan;
}

export interface User {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly plan: Plan;
}

export type QuotaRule = "MAX_UNITS_PER_REQUEST" | "MONTHLY_ALLOWANCE";
export type QuotaLevel = "ACCOUNT" | "USER";

/** Plan, limits and usage of one level as they were when a decision was made. */
export interface DecisionLevel {
  readonly planId: string;
  readonly planName: string;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly used: number;
  readonly remaining: number;
}

/** A consume decision: the POST /v1/consume response and each GET /v1/history item. */
export interface Decision {
  readonly requestId: string;
  readonly userId: string;
  readonly units: number;
  readonly accepted: boolean;
  readonly blockingRule: QuotaRule | null;
  readonly blockingLevel: QuotaLevel | null;
  /** UTC month of the decision, `YYYY-MM`. */
  readonly month: string;
  readonly processedAt: string;
  readonly account: DecisionLevel;
  readonly user: DecisionLevel;
}

export interface ConsumeRequest {
  readonly userId: string;
  readonly units: number;
  readonly requestId: string;
}

/** The current month adds the live plan's limits; a past month reports `used` only. */
export interface MonthlyUsage {
  readonly month: string;
  readonly used: number;
  readonly monthlyAllowance?: number;
  readonly maxUnitsPerRequest?: number;
  readonly remaining?: number;
}

export interface UserUsage {
  readonly userId: string;
  readonly name: string;
  readonly used: number;
  /** The remaining fields are present only on current-month pages. */
  readonly planId?: string;
  readonly planName?: string;
  readonly monthlyAllowance?: number;
  readonly maxUnitsPerRequest?: number;
  readonly remaining?: number;
}

export interface UserPage {
  readonly users: readonly User[];
  readonly nextCursor: string | null;
}

export interface UserUsagePage {
  readonly month: string;
  readonly currentMonth: boolean;
  readonly users: readonly UserUsage[];
  readonly nextCursor: string | null;
}

export interface HistoryPage {
  readonly userId: string | null;
  readonly month: string | null;
  readonly decisions: readonly Decision[];
  readonly nextCursor: string | null;
}

export interface PageQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

/** The single error body of every non-2xx response. */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}
