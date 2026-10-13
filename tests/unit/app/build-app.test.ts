import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../../src/app/build-app.js";
import type { ReadinessResult } from "../../../src/modules/health/health.routes.js";
import { createLogger } from "../../../src/shared/logger.js";
import { createSilentLogger } from "../../helpers/logger.js";
import { testAppDependencies } from "../../helpers/app-stubs.js";

// These tests exercise HTTP routing, the error contract and OpenAPI generation with an injected
// readiness result. Readiness against a real PostgreSQL database is covered by integration tests.

let app: App | undefined;

async function appWithReadiness(result: ReadinessResult): Promise<App> {
  app = await buildApp(
    testAppDependencies({
      logger: createSilentLogger(),
      checkReadiness: () => Promise.resolve(result),
    }),
  );
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("health routes", () => {
  it("reports liveness without consulting readiness", async () => {
    const instance = await buildApp(
      testAppDependencies({
        logger: createSilentLogger(),
        checkReadiness: () => Promise.reject(new Error("must not be called")),
      }),
    );
    app = instance;

    const response = await instance.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("reports ready when the readiness check passes", async () => {
    const instance = await appWithReadiness({ ready: true });

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it.each([
    ["DATABASE_UNAVAILABLE", "The database is not reachable"],
    ["MIGRATIONS_NOT_CURRENT", "Database migrations are not current"],
  ] as const)("returns 503 with the standard error shape for %s", async (reason, message) => {
    const instance = await appWithReadiness({ ready: false, reason });

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers unhandled readiness failures with a generic 500", async () => {
    const instance = await buildApp(
      testAppDependencies({
        logger: createSilentLogger(),
        checkReadiness: () => Promise.reject(new Error("password=hunter2 leaked in driver error")),
      }),
    );
    app = instance;

    const response = await instance.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(response.body).not.toContain("hunter2");
  });
});

describe("application contract", () => {
  it("answers unknown routes with the standard 404 error", async () => {
    const instance = await appWithReadiness({ ready: true });

    const response = await instance.inject({ method: "GET", url: "/does-not-exist?token=abc" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
    expect(response.body).not.toContain("token");
  });

  it("publishes an OpenAPI document describing the health endpoints", async () => {
    const instance = await appWithReadiness({ ready: true });

    const response = await instance.inject({ method: "GET", url: "/docs/json" });
    const document = response.json<{
      openapi: string;
      info: { title: string };
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
    }>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("Usage Metering and Quota Service API");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(["/health/live", "/health/ready"]),
    );
    expect(Object.keys(document.paths["/health/ready"]?.get?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "503"]),
    );
  });

  it("serves the interactive documentation page", async () => {
    const instance = await appWithReadiness({ ready: true });

    const response = await instance.inject({ method: "GET", url: "/docs" });

    expect([200, 302]).toContain(response.statusCode);
  });
});

describe("request logging", () => {
  it("keeps successful health probes out of the logs but still logs other requests", async () => {
    const lines: string[] = [];
    const instance = await buildApp(
      testAppDependencies({
        logger: createLogger("info", { write: (line: string) => lines.push(line) }),
        checkReadiness: () => Promise.resolve({ ready: true }),
      }),
    );
    app = instance;

    await instance.inject({ method: "GET", url: "/health/live" });
    await instance.inject({ method: "GET", url: "/health/ready" });
    expect(lines).toEqual([]);

    await instance.inject({ method: "GET", url: "/docs/json" });
    expect(lines.some((line) => line.includes('"msg":"incoming request"'))).toBe(true);
  });

  it("still logs a failed readiness check as a warning", async () => {
    const lines: string[] = [];
    const instance = await buildApp(
      testAppDependencies({
        logger: createLogger("info", { write: (line: string) => lines.push(line) }),
        checkReadiness: () => Promise.resolve({ ready: false, reason: "DATABASE_UNAVAILABLE" }),
      }),
    );
    app = instance;

    await instance.inject({ method: "GET", url: "/health/ready" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"msg":"readiness check failed"');
    expect(lines[0]).toContain('"reason":"DATABASE_UNAVAILABLE"');
  });
});
