import type { AppDependencies } from "../../src/app/build-app.js";
import type { AccountsService } from "../../src/modules/accounts/accounts.service.js";
import type { ResolveAccountByApiKeyHash } from "../../src/modules/auth/authenticate.js";
import type { ConsumptionService } from "../../src/modules/consumption/consume.service.js";
import type { PlansService } from "../../src/modules/plans/plans.service.js";
import type { UsageService } from "../../src/modules/usage/usage.service.js";
import type { UsersService } from "../../src/modules/users/users.service.js";
import { createSilentLogger } from "./logger.js";

/**
 * Stand-ins for application services a test does not exercise. Any call fails loudly, so a test
 * can never pass by accidentally hitting a stub instead of the behavior it means to check.
 */
function unavailable(service: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${service} is not available in this test`));
}

export const unusedAccountsService: AccountsService = {
  createAccount: unavailable("AccountsService"),
  getAccount: unavailable("AccountsService"),
  assignPlan: unavailable("AccountsService"),
};

export const unusedPlansService: PlansService = {
  listPlans: unavailable("PlansService"),
  createPlan: unavailable("PlansService"),
  updatePlan: unavailable("PlansService"),
};

export const unusedUsersService: UsersService = {
  createUser: unavailable("UsersService"),
  getUser: unavailable("UsersService"),
  listUsers: unavailable("UsersService"),
  assignPlan: unavailable("UsersService"),
};

export const unusedConsumptionService: ConsumptionService = {
  consume: unavailable("ConsumptionService"),
};

export const unusedUsageService: UsageService = {
  getAccountUsage: unavailable("UsageService"),
  getUserUsage: unavailable("UsageService"),
};

/** Knows no API key: every authenticated request is rejected. */
export const resolveNoApiKeys: ResolveAccountByApiKeyHash = () => Promise.resolve(undefined);

/** Application dependencies for unit tests: unused services by default, overridable per test. */
export function testAppDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    logger: createSilentLogger(),
    checkReadiness: () => Promise.resolve({ ready: true }),
    accounts: unusedAccountsService,
    plans: unusedPlansService,
    users: unusedUsersService,
    consumption: unusedConsumptionService,
    usage: unusedUsageService,
    resolveAccountByApiKeyHash: resolveNoApiKeys,
    ...overrides,
  };
}
