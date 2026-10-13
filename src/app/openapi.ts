import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { API_KEY_HEADER } from "../modules/auth/authenticate.js";

/** Version of the HTTP API contract described by the OpenAPI document. */
export const API_CONTRACT_VERSION = "0.1.0";

/**
 * Generates the OpenAPI document from the route schemas and serves interactive documentation at
 * /docs (JSON at /docs/json). Must be registered before any route so that every route is captured.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Usage Metering and Quota Service API",
        version: API_CONTRACT_VERSION,
        description:
          "Meters usage and enforces account-level and user-level monthly quotas. This document grows with each implementation phase.",
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            name: API_KEY_HEADER,
            description: "The account API key returned once by POST /v1/accounts",
          },
        },
      },
      tags: [
        { name: "health", description: "Liveness and readiness probes" },
        { name: "accounts", description: "Account creation and the authenticated account" },
        { name: "plans", description: "Predefined and custom plans" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
}
