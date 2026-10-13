import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
import {
  CreatePlanBodySchema,
  PlanListQuerySchema,
  PlanListSchema,
  PlanParamsSchema,
  PlanSchema,
  UpdatePlanBodySchema,
  type PlanResponse,
} from "./plan.schemas.js";
import type { PlanRecord } from "./plans.repository.js";
import type { PlansService } from "./plans.service.js";

export interface PlanRoutesOptions {
  readonly plans: PlansService;
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
}

export function toPlanResponse(plan: PlanRecord): PlanResponse {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    scope: plan.scope,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export const planRoutes: FastifyPluginAsyncTypebox<PlanRoutesOptions> = (app, options) => {
  const { plans, authenticate } = options;

  app.get(
    "/v1/plans",
    {
      onRequest: authenticate,
      schema: {
        tags: ["plans"],
        summary: "List available plans",
        description:
          "Predefined plans and the account's own custom plans, optionally filtered by scope. Other accounts' custom plans are never listed.",
        security: [{ apiKey: [] }],
        querystring: PlanListQuerySchema,
        response: {
          200: PlanListSchema,
          ...errorResponseSchemas("VALIDATION_ERROR", "UNAUTHORIZED", "INTERNAL_ERROR"),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      const visible = await plans.listPlans(id, request.query.scope);
      return { plans: visible.map(toPlanResponse) };
    },
  );

  app.post(
    "/v1/plans",
    {
      onRequest: authenticate,
      schema: {
        tags: ["plans"],
        summary: "Create a custom plan",
        description:
          "Creates a custom plan owned by the authenticated account. It can be assigned to that account (scope ACCOUNT) or to its users (scope USER).",
        security: [{ apiKey: [] }],
        body: CreatePlanBodySchema,
        response: {
          201: PlanSchema,
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
      const plan = await plans.createPlan(id, request.body);
      return reply.status(201).send(toPlanResponse(plan));
    },
  );

  app.patch(
    "/v1/plans/:planId",
    {
      onRequest: authenticate,
      schema: {
        tags: ["plans"],
        summary: "Update a custom plan",
        description:
          "Changes the name or limits of one of the account's own custom plans. The change applies to every account or user the plan is assigned to. Predefined plans are read-only (409 PLAN_READ_ONLY); unknown plans and other accounts' plans are not found (404).",
        security: [{ apiKey: [] }],
        params: PlanParamsSchema,
        body: UpdatePlanBodySchema,
        response: {
          200: PlanSchema,
          ...errorResponseSchemas(
            "VALIDATION_ERROR",
            "BAD_REQUEST",
            "UNAUTHORIZED",
            "NOT_FOUND",
            "PLAN_READ_ONLY",
            "PAYLOAD_TOO_LARGE",
            "UNSUPPORTED_MEDIA_TYPE",
            "INTERNAL_ERROR",
          ),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      return toPlanResponse(await plans.updatePlan(id, request.params.planId, request.body));
    },
  );

  return Promise.resolve();
};
