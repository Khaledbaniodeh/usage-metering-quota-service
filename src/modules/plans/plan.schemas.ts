import { Type, type Static } from "typebox";

/** Public representation of a plan and its two rules, shared by every response that shows one. */
export const PlanSummarySchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    code: Type.Union([Type.String(), Type.Null()], {
      description: "Stable code of a predefined plan (e.g. starter); null for custom plans",
    }),
    name: Type.String(),
    scope: Type.Enum(["ACCOUNT", "USER"], {
      description: "Whether the plan applies to an account (shared) or to a user (individual)",
    }),
    monthlyAllowance: Type.Integer({
      minimum: 1,
      description: "Units available per UTC calendar month",
    }),
    maxUnitsPerRequest: Type.Integer({
      minimum: 1,
      description: "Largest number of units a single request may consume",
    }),
  },
  { additionalProperties: false },
);

export type PlanSummary = Static<typeof PlanSummarySchema>;
