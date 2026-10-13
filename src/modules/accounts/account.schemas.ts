import { Type, type Static } from "typebox";
import { PlanSummarySchema } from "../plans/plan.schemas.js";

/** Same rule as the accounts_name_format database constraint, plus single-line. */
export const AccountNameSchema = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^\\S(?:.*\\S)?$",
  description:
    "Display name, 1-100 characters on a single line without leading or trailing whitespace. Not unique.",
});

export const CreateAccountBodySchema = Type.Object(
  { name: AccountNameSchema },
  { additionalProperties: false },
);

const accountProperties = {
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  plan: PlanSummarySchema,
};

export const AccountSchema = Type.Object(accountProperties, {
  additionalProperties: false,
  description: "An account and the account plan currently assigned to it",
});

export const CreatedAccountSchema = Type.Object(
  {
    ...accountProperties,
    apiKey: Type.String({
      pattern: "^umqs_[A-Za-z0-9_-]{43}$",
      description:
        "The account's API key. Returned only in this response: store it securely; the service keeps only its SHA-256 digest and cannot show it again.",
    }),
  },
  { additionalProperties: false, description: "The new account and its one-time API key" },
);

export type AccountResponse = Static<typeof AccountSchema>;
export type CreatedAccountResponse = Static<typeof CreatedAccountSchema>;
