import type { AccountsService } from "../../src/modules/accounts/accounts.service.js";
import type { ResolveAccountByApiKeyHash } from "../../src/modules/auth/authenticate.js";

/**
 * Stand-in for application services a test does not exercise. Any call fails loudly, so a test
 * can never pass by accidentally hitting a stub instead of the behavior it means to check.
 */
export const unusedAccountsService: AccountsService = {
  createAccount: () => Promise.reject(new Error("AccountsService is not available in this test")),
  getAccount: () => Promise.reject(new Error("AccountsService is not available in this test")),
};

/** Knows no API key: every authenticated request is rejected. */
export const resolveNoApiKeys: ResolveAccountByApiKeyHash = () => Promise.resolve(undefined);
