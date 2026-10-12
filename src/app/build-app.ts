import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyBaseLogger } from "fastify";
import type { Logger } from "pino";
import { healthRoutes, type ReadinessCheck } from "../modules/health/health.routes.js";
import { registerErrorHandling } from "./error-handler.js";
import { registerOpenApi } from "./openapi.js";

export interface AppDependencies {
  readonly logger: Logger;
  readonly checkReadiness: ReadinessCheck;
}

/**
 * Builds the Fastify application without starting to listen. Process startup (migrations, the
 * database pool, signals) lives in server.ts and main.ts, so tests can construct the application
 * with explicit dependencies.
 */
export async function buildApp(dependencies: AppDependencies) {
  // Typed as Fastify's logger contract so plugins and handlers see one consistent logger type.
  const logger: FastifyBaseLogger = dependencies.logger;
  const app = Fastify({
    loggerInstance: logger,
    return503OnClosing: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  registerErrorHandling(app);
  await registerOpenApi(app);
  await app.register(healthRoutes, { checkReadiness: dependencies.checkReadiness });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
