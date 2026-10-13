import type { AccountsService } from "../../src/modules/accounts/accounts.service.js";

/**
 * Stand-in for application services a test does not exercise. Any call fails loudly, so a test
 * can never pass by accidentally hitting a stub instead of the behavior it means to check.
 */
export const unusedAccountsService: AccountsService = {
  createAccount: () => Promise.reject(new Error("AccountsService is not available in this test")),
};
