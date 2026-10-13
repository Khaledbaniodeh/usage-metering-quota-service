import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { ErrorResponseSchema, errorResponse } from "../../shared/http-errors.js";

export type NotReadyReason = "DATABASE_UNAVAILABLE" | "MIGRATIONS_NOT_CURRENT";

export type ReadinessResult =
  { readonly ready: true } | { readonly ready: false; readonly reason: NotReadyReason };

/** Port implemented by the infrastructure layer; the health module only depends on this contract. */
export type ReadinessCheck = () => Promise<ReadinessResult>;

export interface HealthRoutesOptions {
  readonly checkReadiness: ReadinessCheck;
}

const NOT_READY_MESSAGES: Readonly<Record<NotReadyReason, string>> = {
  DATABASE_UNAVAILABLE: "The database is not reachable",
  MIGRATIONS_NOT_CURRENT: "Database migrations are not current",
};

const LiveResponseSchema = Type.Object(
  { status: Type.Literal("ok") },
  { additionalProperties: false, description: "The process is running" },
);

const ReadyResponseSchema = Type.Object(
  { status: Type.Literal("ready") },
  {
    additionalProperties: false,
    description: "The database is reachable and every migration has been applied",
  },
);

/**
 * Probes run every few seconds (container health checks, orchestrators), so their per-request
 * "incoming request"/"request completed" lines are suppressed; warnings such as a failed readiness
 * check are still logged.
 */
const PROBE_LOG_LEVEL = "warn";

export const healthRoutes: FastifyPluginAsyncTypebox<HealthRoutesOptions> = (app, options) => {
  app.addHook("onSend", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
  });

  app.get(
    "/health/live",
    {
      logLevel: PROBE_LOG_LEVEL,
      schema: {
        tags: ["health"],
        summary: "Liveness probe",
        description: "Reports that the process is running. Does not touch the database.",
        response: { 200: LiveResponseSchema },
      },
    },
    () => ({ status: "ok" as const }),
  );

  app.get(
    "/health/ready",
    {
      logLevel: PROBE_LOG_LEVEL,
      schema: {
        tags: ["health"],
        summary: "Readiness probe",
        description:
          "Reports ready only when PostgreSQL is reachable and the applied migrations exactly match the migrations shipped with this build.",
        response: { 200: ReadyResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await options.checkReadiness();
      if (result.ready) {
        return { status: "ready" as const };
      }
      request.log.warn({ reason: result.reason }, "readiness check failed");
      return reply
        .status(503)
        .send(errorResponse("SERVICE_UNAVAILABLE", NOT_READY_MESSAGES[result.reason]));
    },
  );

  return Promise.resolve();
};
