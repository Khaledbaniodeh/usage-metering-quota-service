import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { errorResponseSchemas } from "../../shared/http-errors.js";
import {
  CreateAccountBodySchema,
  CreatedAccountSchema,
  type AccountResponse,
} from "./account.schemas.js";
import type { AccountRecord } from "./accounts.repository.js";
import type { AccountsService } from "./accounts.service.js";

export interface AccountRoutesOptions {
  readonly accounts: AccountsService;
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

  return Promise.resolve();
};
