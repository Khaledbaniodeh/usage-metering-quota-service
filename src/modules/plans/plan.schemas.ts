import { Type, type Static } from "typebox";
import { displayNameSchema } from "../../shared/display-name.js";

/** Upper bound of every plan limit (and of units per request), as in the database constraints. */
export const PLAN_LIMIT_MAX = 1_000_000_000;

export const PlanScopeSchema = Type.Enum(["ACCOUNT", "USER"], {
  description: "Whether the plan applies to an account (shared) or to a user (individual)",
});

export type PlanScope = Static<typeof PlanScopeSchema>;

function limitSchema(description: string) {
  return Type.Integer({ minimum: 1, maximum: PLAN_LIMIT_MAX, description });
}

const MonthlyAllowanceSchema = limitSchema(
  "Units available per UTC calendar month (1-1,000,000,000)",
);
const MaxUnitsPerRequestSchema = limitSchema(
  "Largest number of units a single request may consume (1-1,000,000,000)",
);
const PlanNameSchema = displayNameSchema(
  "Plan name: 1-100 characters on a single line, without control characters or leading or trailing whitespace.",
);

const planSummaryProperties = {
  id: Type.String({ format: "uuid" }),
  code: Type.Union([Type.String(), Type.Null()], {
    description: "Stable code of a predefined plan (e.g. starter); null for custom plans",
  }),
  name: Type.String(),
  scope: PlanScopeSchema,
  monthlyAllowance: MonthlyAllowanceSchema,
  maxUnitsPerRequest: MaxUnitsPerRequestSchema,
};

/** Public representation of a plan and its two rules, embedded in account and user responses. */
export const PlanSummarySchema = Type.Object(planSummaryProperties, {
  additionalProperties: false,
});

export type PlanSummary = Static<typeof PlanSummarySchema>;

/** A plan as a resource of its own. */
export const PlanSchema = Type.Object(
  {
    ...planSummaryProperties,
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type PlanResponse = Static<typeof PlanSchema>;

export const PlanListSchema = Type.Object(
  { plans: Type.Array(PlanSchema) },
  {
    additionalProperties: false,
    description:
      "Predefined plans first, then the account's own custom plans in creation order. Other accounts' custom plans are never included.",
  },
);

export const PlanListQuerySchema = Type.Object(
  { scope: Type.Optional(PlanScopeSchema) },
  { additionalProperties: false },
);

export const CreatePlanBodySchema = Type.Object(
  {
    name: PlanNameSchema,
    scope: PlanScopeSchema,
    monthlyAllowance: MonthlyAllowanceSchema,
    maxUnitsPerRequest: MaxUnitsPerRequestSchema,
  },
  { additionalProperties: false },
);

export const UpdatePlanBodySchema = Type.Object(
  {
    name: Type.Optional(PlanNameSchema),
    monthlyAllowance: Type.Optional(MonthlyAllowanceSchema),
    maxUnitsPerRequest: Type.Optional(MaxUnitsPerRequestSchema),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description:
      "At least one field. Scope, owner and code cannot be changed; predefined plans cannot be updated.",
  },
);

export const PlanParamsSchema = Type.Object(
  { planId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

/** Body of PUT /v1/account/plan and PUT /v1/users/{userId}/plan. */
export const AssignPlanBodySchema = Type.Object(
  {
    planId: Type.String({
      format: "uuid",
      description: "A predefined plan or one of the account's own custom plans, of the right scope",
    }),
  },
  { additionalProperties: false },
);
