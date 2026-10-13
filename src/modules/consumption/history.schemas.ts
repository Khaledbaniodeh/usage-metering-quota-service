import { Type } from "typebox";
import {
  CursorQuerySchema,
  LimitQuerySchema,
  MonthQuerySchema,
} from "../../shared/query-params.js";
import { ConsumeDecisionSchema } from "./consume.schemas.js";

export const HistoryQuerySchema = Type.Object(
  {
    userId: Type.Optional(
      Type.String({ format: "uuid", description: "Only decisions for this user of the account" }),
    ),
    month: Type.Optional(MonthQuerySchema),
    limit: Type.Optional(LimitQuerySchema),
    cursor: Type.Optional(CursorQuerySchema),
  },
  { additionalProperties: false },
);

export const HistoryPageSchema = Type.Object(
  {
    userId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
      description: "The user filter in effect (from the request or the cursor); null when none",
    }),
    month: Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}$" }), Type.Null()], {
      description: "The month filter in effect (YYYY-MM, UTC); null when none",
    }),
    decisions: Type.Array(ConsumeDecisionSchema, {
      description:
        "Stored decisions, newest first, each exactly as POST /v1/consume returned it: plan names, limits and usage as they were when it was decided",
    }),
    nextCursor: Type.Union([Type.String(), Type.Null()], {
      description: "Pass as cursor to get the next page; null on the last page",
    }),
  },
  { additionalProperties: false, description: "One page of the account's decision history" },
);
