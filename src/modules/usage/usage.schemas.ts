import { Type, type Static } from "typebox";
import {
  CursorQuerySchema,
  LimitQuerySchema,
  MonthQuerySchema,
} from "../../shared/query-params.js";

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

export const UserUsageListQuerySchema = Type.Object(
  {
    month: Type.Optional(MonthQuerySchema),
    limit: Type.Optional(LimitQuerySchema),
    cursor: Type.Optional(CursorQuerySchema),
  },
  { additionalProperties: false },
);

const listedUserProperties = {
  userId: Type.String({ format: "uuid" }),
  name: Type.String(),
};

const nextCursorProperties = {
  nextCursor: Type.Union([Type.String(), Type.Null()], {
    description:
      "Pass as cursor to get the next page; null on the last page. A current-month cursor expires when the UTC month changes.",
  }),
};

const CurrentMonthUserUsagePageSchema = Type.Object(
  {
    month: MonthKeySchema,
    currentMonth: Type.Literal(true, {
      description: "The month was the current UTC month when the traversal began",
    }),
    users: Type.Array(
      Type.Object(
        {
          ...listedUserProperties,
          planId: Type.String({ format: "uuid" }),
          planName: Type.String(),
          ...usedProperties,
          ...currentLimitProperties,
        },
        { additionalProperties: false },
      ),
    ),
    ...nextCursorProperties,
  },
  { additionalProperties: false, title: "CurrentMonthUserUsagePage" },
);

const PastMonthUserUsagePageSchema = Type.Object(
  {
    month: MonthKeySchema,
    currentMonth: Type.Literal(false),
    users: Type.Array(
      Type.Object({ ...listedUserProperties, ...usedProperties }, { additionalProperties: false }),
    ),
    ...nextCursorProperties,
  },
  { additionalProperties: false, title: "PastMonthUserUsagePage" },
);

export const UserUsagePageSchema = Type.Union(
  [CurrentMonthUserUsagePageSchema, PastMonthUserUsagePageSchema],
  {
    description:
      "One page of every user's usage for a UTC month, newest user first. The form (current or past month) is fixed for the whole traversal.",
  },
);
