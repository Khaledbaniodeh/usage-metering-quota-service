import { Type, type Static } from "typebox";
import { MonthQuerySchema } from "../../shared/query-params.js";

export const MonthKeySchema = Type.String({
  pattern: "^\\d{4}-\\d{2}$",
  description: "UTC month (YYYY-MM)",
});

export const usedProperties = {
  used: Type.Integer({
    minimum: 0,
    description: "Units consumed in the month (accepted requests only); 0 when nothing was used",
  }),
};

/** Live-plan fields, present only for the current month. */
export const currentLimitProperties = {
  monthlyAllowance: Type.Integer({ description: "Monthly allowance of the plan assigned now" }),
  maxUnitsPerRequest: Type.Integer({ description: "Per-request limit of the plan assigned now" }),
  remaining: Type.Integer({
    minimum: 0,
    description: "monthlyAllowance - used, never below zero",
  }),
};

/** The current month: usage with the limits of the plan assigned now. */
export const CurrentMonthUsageSchema = Type.Object(
  { month: MonthKeySchema, ...usedProperties, ...currentLimitProperties },
  { additionalProperties: false, title: "CurrentMonthUsage" },
);

/**
 * A past month: usage only. The plan assigned now says nothing about what was available then;
 * the limits that applied are recorded on each decision in GET /v1/history.
 */
export const PastMonthUsageSchema = Type.Object(
  { month: MonthKeySchema, ...usedProperties },
  { additionalProperties: false, title: "PastMonthUsage" },
);

export const MonthlyUsageSchema = Type.Union([CurrentMonthUsageSchema, PastMonthUsageSchema], {
  description:
    "Usage for one UTC month: the current month includes the live plan limits and remaining units; a past month reports used only.",
});

export type MonthlyUsageResponse = Static<typeof MonthlyUsageSchema>;

export const UsageQuerySchema = Type.Object(
  { month: Type.Optional(MonthQuerySchema) },
  { additionalProperties: false },
);
