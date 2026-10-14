import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { parseLimit } from "../../shared/query-params.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
import { toDecisionResponse } from "./consume.domain.js";
import { HistoryPageSchema, HistoryQuerySchema } from "./history.schemas.js";
import type { HistoryService } from "./history.service.js";

export interface HistoryRoutesOptions {
  readonly history: HistoryService;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
}

export const historyRoutes: FastifyPluginAsyncTypebox<HistoryRoutesOptions> = (app, options) => {
  app.get(
    "/v1/history",
    {
      onRequest: options.authenticate,
      schema: {
        tags: ["history"],
        summary: "Decision history",
        description:
          "The authenticated account's consume decisions, newest first, one page at a time (limit 1-100, default 20), each exactly as originally returned (stored snapshots; later plan changes never alter it). Optional filters: userId (a user of the account; unknown and other accounts' users are both 404) and month (YYYY-MM, UTC; a future month is 400). The response echoes the filters in effect. Follow nextCursor until it is null: the cursor carries the filters, so a continuation may send only cursor (and limit), may repeat the same filters but not change them. Any unusable cursor is 400 \"Invalid cursor\".",
        security: [{ apiKey: [] }],
        querystring: HistoryQuerySchema,
        response: {
          200: HistoryPageSchema,
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
      const { userId, month, cursor, limit } = request.query;
      const page = await options.history.listHistory(id, {
        userId,
        month,
        cursor,
        limit: parseLimit(limit),
      });
      return {
        userId: page.userId,
        month: page.month,
        decisions: page.decisions.map(toDecisionResponse),
        nextCursor: page.nextCursor,
      };
    },
  );

  return Promise.resolve();
};
