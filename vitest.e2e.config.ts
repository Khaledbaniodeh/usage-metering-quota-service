import { defineConfig } from "vitest/config";

/**
 * Black-box end-to-end test (`npm run test:e2e`): runs the example client executable against a
 * service that is already running at API_BASE_URL (default http://127.0.0.1:8080). Kept out of
 * vitest.config.ts so `npm test` never needs a running service.
 */
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
