import { Type, type Static } from "typebox";
import { displayNameSchema } from "../../shared/display-name.js";
import { PlanSummarySchema } from "../plans/plan.schemas.js";

export const CreateUserBodySchema = Type.Object(
  {
    name: displayNameSchema(
      "User display name: 1-100 characters on a single line, without control characters or leading or trailing whitespace. Not unique.",
    ),
  },
  { additionalProperties: false },
);

export const UserSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    plan: PlanSummarySchema,
  },
  {
    additionalProperties: false,
    description: "A user of the authenticated account and the user plan currently assigned to it",
  },
);

export type UserResponse = Static<typeof UserSchema>;

export const UserListSchema = Type.Object(
  { users: Type.Array(UserSchema) },
  {
    additionalProperties: false,
    description: "Every user of the authenticated account, oldest first",
  },
);

/** GET /v1/users takes no query parameters; any parameter is rejected. */
export const UserListQuerySchema = Type.Object({}, { additionalProperties: false });

export const UserParamsSchema = Type.Object(
  { userId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
