import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      // Measured across unit + integration tests with no production file excluded. The process
      // entry points (main.ts, migrate-cli.ts) are exercised as child processes, which V8
      // coverage cannot instrument, so they count as uncovered here.
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          // Recreates the dedicated *_test database once per run.
          globalSetup: ["tests/helpers/global-setup.ts"],
          // Integration test files share one database, so they run one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
