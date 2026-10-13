import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { parseLimit } from "../../shared/query-params.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
import { AssignPlanBodySchema } from "../plans/plan.schemas.js";
import {
  CreateUserBodySchema,
  UserListQuerySchema,
  UserListSchema,
  UserParamsSchema,
  UserSchema,
  type UserResponse,
} from "./user.schemas.js";
import type { UserRecord } from "./users.repository.js";
import type { UsersService } from "./users.service.js";

export interface UserRoutesOptions {
  readonly users: UsersService;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
}

export function toUserResponse(user: UserRecord): UserResponse {
  return {
    id: user.id,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    plan: user.plan,
  };
}

export const userRoutes: FastifyPluginAsyncTypebox<UserRoutesOptions> = (app, options) => {
  const { users, authenticate } = options;

  app.post(
    "/v1/users",
    {
      onRequest: authenticate,
      schema: {
        tags: ["users"],
        summary: "Register a user",
        description:
          "Registers a user under the authenticated account, on the predefined Basic user plan.",
        security: [{ apiKey: [] }],
        body: CreateUserBodySchema,
        response: {
          201: UserSchema,
          ...errorResponseSchemas(
            "VALIDATION_ERROR",
            "BAD_REQUEST",
            "UNAUTHORIZED",
            "PAYLOAD_TOO_LARGE",
            "UNSUPPORTED_MEDIA_TYPE",
            "INTERNAL_ERROR",
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = requireAuthenticatedAccount(request);
      const user = await users.createUser(id, request.body.name);
      return reply.status(201).send(toUserResponse(user));
    },
  );

  app.get(
    "/v1/users",
    {
      onRequest: authenticate,
      schema: {
        tags: ["users"],
        summary: "List the account's users",
        description:
          'The authenticated account\'s users with their plans, oldest first, one page at a time (limit 1-100, default 20). Follow nextCursor until it is null; a continuation request may send only cursor (and optionally limit). Any unusable cursor is 400 "Invalid cursor".',
        security: [{ apiKey: [] }],
        querystring: UserListQuerySchema,
        response: {
          200: UserListSchema,
          ...errorResponseSchemas("VALIDATION_ERROR", "UNAUTHORIZED", "INTERNAL_ERROR"),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      const { limit, cursor } = request.query;
      const page = await users.listUsers(id, { limit: parseLimit(limit), cursor });
      return { users: page.users.map(toUserResponse), nextCursor: page.nextCursor };
    },
  );

  app.get(
    "/v1/users/:userId",
    {
      onRequest: authenticate,
      schema: {
        tags: ["users"],
        summary: "Get a user",
        description:
          "A user of the authenticated account with its plan. Unknown users and other accounts' users are both 404.",
        security: [{ apiKey: [] }],
        params: UserParamsSchema,
        response: {
          200: UserSchema,
          ...errorResponseSchemas(
            "VALIDATION_ERROR",
            "UNAUTHORIZED",
            "NOT_FOUND",
            "INTERNAL_ERROR",
          ),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      return toUserResponse(await users.getUser(id, request.params.userId));
    },
  );

  app.put(
    "/v1/users/:userId/plan",
    {
      onRequest: authenticate,
      schema: {
        tags: ["users"],
        summary: "Switch a user's plan",
        description:
          'Assigns a predefined user plan or one of the account\'s own custom USER plans to a user of the account. Unknown and foreign users are 404 "User not found"; unknown and foreign plans are 404 "Plan not found"; an ACCOUNT plan is 409 PLAN_SCOPE_MISMATCH. Assigning the current plan again succeeds and changes nothing, updatedAt included.',
        security: [{ apiKey: [] }],
        params: UserParamsSchema,
        body: AssignPlanBodySchema,
        response: {
          200: UserSchema,
          ...errorResponseSchemas(
            "VALIDATION_ERROR",
            "BAD_REQUEST",
            "UNAUTHORIZED",
            "NOT_FOUND",
            "PLAN_SCOPE_MISMATCH",
            "PAYLOAD_TOO_LARGE",
            "UNSUPPORTED_MEDIA_TYPE",
            "INTERNAL_ERROR",
          ),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      const { userId } = request.params;
      return toUserResponse(await users.assignPlan(id, userId, request.body.planId));
    },
  );

  return Promise.resolve();
};
