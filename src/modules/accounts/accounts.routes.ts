import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import { requireAuthenticatedAccount } from "../auth/authenticate.js";
import { AssignPlanBodySchema } from "../plans/plan.schemas.js";
import {
  AccountSchema,
  CreateAccountBodySchema,
  CreatedAccountSchema,
  type AccountResponse,
} from "./account.schemas.js";
import type { AccountRecord } from "./accounts.repository.js";
import type { AccountsService } from "./accounts.service.js";

export interface AccountRoutesOptions {
  readonly accounts: AccountsService;
  /** onRequest hook that authenticates the X-API-Key header. */
  readonly authenticate: (request: FastifyRequest) => Promise<void>;
}

export function toAccountResponse(account: AccountRecord): AccountResponse {
  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    plan: account.plan,
  };
}

export const accountRoutes: FastifyPluginAsyncTypebox<AccountRoutesOptions> = (app, options) => {
  app.post(
    "/v1/accounts",
    {
      schema: {
        tags: ["accounts"],
        summary: "Create an account",
        description:
          "Public. Creates an account on the predefined Starter plan and returns its API key. The key is shown only in this response; the service stores only its SHA-256 digest.",
        body: CreateAccountBodySchema,
        response: {
          201: CreatedAccountSchema,
          ...errorResponseSchemas(
            "VALIDATION_ERROR",
            "BAD_REQUEST",
            "PAYLOAD_TOO_LARGE",
            "UNSUPPORTED_MEDIA_TYPE",
            "INTERNAL_ERROR",
          ),
        },
      },
    },
    async (request, reply) => {
      const { account, apiKey } = await options.accounts.createAccount(request.body.name);
      // The body carries a one-time secret: it must not be stored by any cache.
      return reply
        .status(201)
        .header("cache-control", "no-store")
        .send({ ...toAccountResponse(account), apiKey });
    },
  );

  app.get(
    "/v1/account",
    {
      onRequest: options.authenticate,
      schema: {
        tags: ["accounts"],
        summary: "Get the authenticated account",
        description:
          "Returns the account that owns the X-API-Key, with the account plan currently assigned to it.",
        security: [{ apiKey: [] }],
        response: {
          200: AccountSchema,
          ...errorResponseSchemas("UNAUTHORIZED", "NOT_FOUND", "INTERNAL_ERROR"),
        },
      },
    },
    async (request) => {
      const { id } = requireAuthenticatedAccount(request);
      return toAccountResponse(await options.accounts.getAccount(id));
    },
  );

  app.put(
    "/v1/account/plan",
    {
      onRequest: options.authenticate,
      schema: {
        tags: ["accounts"],
        summary: "Switch the account plan",
        description:
          "Assigns a predefined account plan or one of the account's own custom ACCOUNT plans. Unknown plans and other accounts' plans are both 404; a USER plan is 409 PLAN_SCOPE_MISMATCH. Assigning the current plan again succeeds and changes nothing, updatedAt included.",
        security: [{ apiKey: [] }],
        body: AssignPlanBodySchema,
        response: {
          200: AccountSchema,
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
      return toAccountResponse(await options.accounts.assignPlan(id, request.body.planId));
    },
  );

  return Promise.resolve();
};
