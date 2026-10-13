import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
import { UserParamsSchema } from "../users/user.schemas.js";
import { MonthlyUsageSchema, UsageQuerySchema } from "./usage.schemas.js";
import type { UsageService } from "./usage.service.js";

export interface UsageRoutesOptions {
  readonly usage: UsageService;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
}

const MONTH_DESCRIPTION =
  "month (YYYY-MM, UTC) defaults to the current month; a future month is 400. The current month includes the live plan's limits and remaining = max(0, allowance - used); a past month reports used only. A month without usage reports 0.";

export const usageRoutes: FastifyPluginAsyncTypebox<UsageRoutesOptions> = (app, options) => {
  const { usage, authenticate } = options;

  app.get(
    "/v1/usage",
    {
      onRequest: authenticate,
      schema: {
        tags: ["usage"],
        summary: "Account usage for a month",
        description: `The authenticated account's shared usage. ${MONTH_DESCRIPTION}`,
        security: [{ apiKey: [] }],
        querystring: UsageQuerySchema,
        response: {
          200: MonthlyUsageSchema,
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
      return usage.getAccountUsage(id, request.query.month);
    },
  );

  app.get(
    "/v1/users/:userId/usage",
    {
      onRequest: authenticate,
      schema: {
        tags: ["usage"],
        summary: "A user's usage for a month",
        description: `The usage of a user of the authenticated account. Unknown users and other accounts' users are both 404. ${MONTH_DESCRIPTION}`,
        security: [{ apiKey: [] }],
        params: UserParamsSchema,
        querystring: UsageQuerySchema,
        response: {
          200: MonthlyUsageSchema,
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
      return usage.getUserUsage(id, request.params.userId, request.query.month);
    },
  );

  return Promise.resolve();
};
