import { defineConfig } from "vitest/config";

/**
 * Black-box end-to-end test (`npm run test:e2e`): checks one complete example-client run against
 * the real service. It reads the Compose client's captured run (CLIENT_LOG and CLIENT_EXIT_CODE,
 * as CI sets them) or, without them, runs the client executable against API_BASE_URL (default
 * http://127.0.0.1:8080). Kept out of vitest.config.ts so `npm test` never needs a running service.
 */
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
