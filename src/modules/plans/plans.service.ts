import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db/pool.js";
import type { Clock } from "../../shared/clock.js";
import { AppError } from "../../shared/http-errors.js";
import { planNotFound } from "./plan-assignment.js";
import type { PlanScope } from "./plan.schemas.js";
import {
  insertCustomPlan,
  listVisiblePlans,
  updateCustomPlan,
  type CustomPlanChanges,
  type PlanRecord,
} from "./plans.repository.js";

export interface NewPlanInput {
  readonly name: string;
  readonly scope: PlanScope;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

export interface PlansService {
  readonly listPlans: (accountId: string, scope?: PlanScope) => Promise<PlanRecord[]>;
  readonly createPlan: (accountId: string, input: NewPlanInput) => Promise<PlanRecord>;
  readonly updatePlan: (
    accountId: string,
    planId: string,
    changes: CustomPlanChanges,
  ) => Promise<PlanRecord>;
}

export interface PlansServiceDependencies {
  readonly db: Queryable;
  readonly clock: Clock;
}

export function createPlansService({ db, clock }: PlansServiceDependencies): PlansService {
  return {
    listPlans: (accountId, scope) => listVisiblePlans(db, accountId, scope),

    createPlan: (accountId, input) =>
      insertCustomPlan(db, { ...input, id: randomUUID(), ownerAccountId: accountId, now: clock() }),

    updatePlan: async (accountId, planId, changes) => {
      const result = await updateCustomPlan(db, accountId, planId, changes, clock());
      switch (result.kind) {
        case "updated":
          return result.plan;
        case "read-only":
          throw new AppError("PLAN_READ_ONLY");
        case "not-found":
          throw planNotFound();
      }
    },
  };
}
