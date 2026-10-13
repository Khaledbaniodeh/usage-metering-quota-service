import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
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
        description: "Every user of the authenticated account with its plan, oldest first.",
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
      return { users: (await users.listUsers(id)).map(toUserResponse) };
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

  return Promise.resolve();
};
