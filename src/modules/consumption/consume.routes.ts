import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
import { toDecisionResponse } from "./consume.domain.js";
import { ConsumeBodySchema, ConsumeDecisionSchema } from "./consume.schemas.js";
import type { ConsumptionService } from "./consume.service.js";

export interface ConsumeRoutesOptions {
  readonly consumption: ConsumptionService;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
}

export const consumeRoutes: FastifyPluginAsyncTypebox<ConsumeRoutesOptions> = (app, options) => {
  app.post(
    "/v1/consume",
    {
      onRequest: options.authenticate,
      schema: {
        tags: ["consumption"],
        summary: "Consume units for a user",
        description:
          "Decides whether the user may consume the units now. Every decision is 200: `accepted: true` counts the units at both levels, `accepted: false` counts nothing and names the first blocking rule (user per-request, account per-request, user monthly, account monthly). Retrying with the same requestId and payload returns the original body; reusing it with another userId or units is 409 IDEMPOTENCY_CONFLICT. 503 BUSY_RETRY (with Retry-After) means nothing was recorded and the same request can be retried.",
        security: [{ apiKey: [] }],
        body: ConsumeBodySchema,
        response: {
          200: ConsumeDecisionSchema,
          ...errorResponseSchemas(
            "VALIDATION_ERROR",
            "BAD_REQUEST",
            "UNAUTHORIZED",
            "NOT_FOUND",
            "IDEMPOTENCY_CONFLICT",
            "PAYLOAD_TOO_LARGE",
            "UNSUPPORTED_MEDIA_TYPE",
            "BUSY_RETRY",
            "INTERNAL_ERROR",
          ),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      const decision = await options.consumption.consume(id, request.body);
      return toDecisionResponse(decision);
    },
  );

  return Promise.resolve();
};
