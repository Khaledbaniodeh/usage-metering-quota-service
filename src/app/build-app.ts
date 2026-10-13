import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyBaseLogger } from "fastify";
import type { Logger } from "pino";
import { accountRoutes } from "../modules/accounts/accounts.routes.js";
import type { AccountsService } from "../modules/accounts/accounts.service.js";
import {
  createAuthenticationHook,
  registerAuthentication,
  type ResolveAccountByApiKeyHash,
} from "../modules/auth/authenticate.js";
import { healthRoutes, type ReadinessCheck } from "../modules/health/health.routes.js";
import { planRoutes } from "../modules/plans/plans.routes.js";
import type { PlansService } from "../modules/plans/plans.service.js";
import { userRoutes } from "../modules/users/users.routes.js";
import type { UsersService } from "../modules/users/users.service.js";
import { registerErrorHandling } from "./error-handler.js";
import { registerOpenApi } from "./openapi.js";

export interface AppDependencies {
  readonly logger: Logger;
  readonly checkReadiness: ReadinessCheck;
  readonly accounts: AccountsService;
  readonly plans: PlansService;
  readonly users: UsersService;
  readonly resolveAccountByApiKeyHash: ResolveAccountByApiKeyHash;
}

/**
 * Builds the Fastify application without starting to listen. Process startup (migrations, the
 * database pool, signals) lives in server.ts and main.ts, and the production wiring of the
 * dependencies lives in dependencies.ts, so tests can construct the application explicitly.
 */
export async function buildApp(dependencies: AppDependencies) {
  // Typed as Fastify's logger contract so plugins and handlers see one consistent logger type.
  const logger: FastifyBaseLogger = dependencies.logger;
  const app = Fastify({
    loggerInstance: logger,
    return503OnClosing: true,
    // Strict request validation: values are never coerced to another type, and unknown body
    // properties are rejected (additionalProperties: false) instead of being silently removed.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  registerErrorHandling(app);
  registerAuthentication(app);
  const authenticate = createAuthenticationHook(dependencies.resolveAccountByApiKeyHash);
  await registerOpenApi(app);
  await app.register(healthRoutes, { checkReadiness: dependencies.checkReadiness });
  await app.register(accountRoutes, { accounts: dependencies.accounts, authenticate });
  await app.register(planRoutes, { plans: dependencies.plans, authenticate });
  await app.register(userRoutes, { users: dependencies.users, authenticate });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
