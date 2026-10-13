import { Type, type Static } from "typebox";
import { PLAN_LIMIT_MAX } from "../plans/plan.schemas.js";
import { QUOTA_LEVELS, QUOTA_RULES } from "./consume.domain.js";

/** Client-generated idempotency key; the same pattern is enforced by the database. */
export const REQUEST_ID_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";

export const ConsumeBodySchema = Type.Object(
  {
    userId: Type.String({
      format: "uuid",
      description: "A user of the authenticated account",
    }),
    units: Type.Integer({
      minimum: 1,
      maximum: PLAN_LIMIT_MAX,
      description: "Units to consume: a JSON integer from 1 to 1,000,000,000",
    }),
    requestId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: REQUEST_ID_PATTERN,
      description:
        "Client-generated idempotency key (1-128 of A-Z a-z 0-9 . _ : -), unique per account. Retrying with the same key and payload returns the original decision.",
    }),
  },
  { additionalProperties: false },
);

export type ConsumeBody = Static<typeof ConsumeBodySchema>;

const DecisionLevelSchema = Type.Object(
  {
    planId: Type.String({ format: "uuid" }),
    planName: Type.String({ description: "Plan name when the decision was made" }),
    monthlyAllowance: Type.Integer({ description: "Monthly allowance applied to the decision" }),
    maxUnitsPerRequest: Type.Integer({ description: "Per-request limit applied to the decision" }),
    used: Type.Integer({
      description: "Units used this month, including this request if accepted",
    }),
    remaining: Type.Integer({
      description: "Units left this month after this decision; never below zero",
    }),
  },
  { additionalProperties: false },
);

export const ConsumeDecisionSchema = Type.Object(
  {
    requestId: Type.String(),
    userId: Type.String({ format: "uuid" }),
    units: Type.Integer(),
    accepted: Type.Boolean({
      description: "true: the units were counted; false: nothing was counted",
    }),
    blockingRule: Type.Union([Type.Enum(QUOTA_RULES), Type.Null()], {
      description: "The first rule that rejected the request; null when accepted",
    }),
    blockingLevel: Type.Union([Type.Enum(QUOTA_LEVELS), Type.Null()], {
      description:
        "Whether the blocking rule belongs to the account or the user; null when accepted",
    }),
    month: Type.String({ pattern: "^\\d{4}-\\d{2}$", description: "UTC month (YYYY-MM)" }),
    processedAt: Type.String({ format: "date-time" }),
    account: DecisionLevelSchema,
    user: DecisionLevelSchema,
  },
  {
    additionalProperties: false,
    description:
      "The stored decision. A retry with the same requestId and payload returns this exact body.",
  },
);
