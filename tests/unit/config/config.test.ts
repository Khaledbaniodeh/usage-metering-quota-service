import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  loadConfigOrReport,
  type Environment,
} from "../../../src/config/config.js";

const VALID_DATABASE_URL = "postgres://app_user:s3cret-value@db.internal:5432/usage_metering";

function configErrorFor(env: Environment): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadConfig to throw a ConfigError");
}

describe("loadConfig", () => {
  it("parses a complete valid configuration", () => {
    const config = loadConfig({
      PORT: "9090",
      LOG_LEVEL: "debug",
      SHUTDOWN_TIMEOUT_MS: "15000",
      DATABASE_URL: VALID_DATABASE_URL,
      DB_POOL_MAX: "20",
      DB_CONNECTION_TIMEOUT_MS: "3000",
      DB_STATEMENT_TIMEOUT_MS: "7000",
      DB_LOCK_TIMEOUT_MS: "1500",
    });

    expect(config).toEqual({
      port: 9090,
      logLevel: "debug",
      shutdownTimeoutMs: 15_000,
      database: {
        url: VALID_DATABASE_URL,
        poolMax: 20,
        connectionTimeoutMs: 3_000,
        statementTimeoutMs: 7_000,
        lockTimeoutMs: 1_500,
      },
    });
  });

  it("applies documented defaults when only DATABASE_URL is provided", () => {
    const config = loadConfig({ DATABASE_URL: VALID_DATABASE_URL });

    expect(config).toEqual({
      port: 8080,
      logLevel: "info",
      shutdownTimeoutMs: 10_000,
      database: {
        url: VALID_DATABASE_URL,
        poolMax: 10,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
        lockTimeoutMs: 2_000,
      },
    });
  });

  it("treats empty optional values as unset", () => {
    const config = loadConfig({ DATABASE_URL: VALID_DATABASE_URL, PORT: "", LOG_LEVEL: "" });

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
  });

  it("requires DATABASE_URL", () => {
    expect(configErrorFor({}).issues).toEqual(["DATABASE_URL is required"]);
    expect(configErrorFor({ DATABASE_URL: "" }).issues).toEqual(["DATABASE_URL is required"]);
  });

  it.each(["0", "65536", "-1", "80.5", " 8080", "8080 ", "abc", "1e3", "0x1F90"])(
    "rejects the invalid port %j",
    (port) => {
      expect(configErrorFor({ DATABASE_URL: VALID_DATABASE_URL, PORT: port }).issues).toEqual([
        "PORT must be an integer between 1 and 65535",
      ]);
    },
  );

  it.each([
    ["not a url", "must not contain whitespace"],
    ["no-scheme-at-all", "must be a valid URL"],
    ["mysql://user:pass@localhost:3306/app", "must use the postgres:// or postgresql:// scheme"],
    ["https://example.com/app", "must use the postgres:// or postgresql:// scheme"],
    ["postgres://user:pass@localhost:5432", "must name a database"],
    ["postgres://user:pass@localhost:5432/", "must name a database"],
    ["postgres://user:pass@localhost:5432/app/extra", "must name a database"],
    ["postgres://user:pass@localhost:5432/app%2", "must contain a valid URL-encoded database name"],
  ])("rejects the database URL %j", (url, expectedProblem) => {
    const [issue] = configErrorFor({ DATABASE_URL: url }).issues;

    expect(issue).toContain(expectedProblem);
  });

  it("accepts the postgresql:// scheme and an encoded database name", () => {
    const url = "postgresql://user:pass@localhost:5432/usage%5Fmetering";

    expect(loadConfig({ DATABASE_URL: url }).database.url).toBe(url);
  });

  it("never includes credentials or the raw URL in error messages", () => {
    const error = configErrorFor({
      DATABASE_URL: "mysql://admin:TopSecretPassword@db.internal:3306/app",
    });

    expect(error.message).not.toContain("TopSecretPassword");
    expect(error.message).not.toContain("db.internal");
  });

  it("rejects an unknown log level", () => {
    expect(
      configErrorFor({ DATABASE_URL: VALID_DATABASE_URL, LOG_LEVEL: "verbose" }).issues,
    ).toEqual(["LOG_LEVEL must be one of: fatal, error, warn, info, debug, trace, silent"]);
  });

  it.each([
    ["DB_POOL_MAX", "0", "DB_POOL_MAX must be an integer between 1 and 100"],
    ["DB_POOL_MAX", "101", "DB_POOL_MAX must be an integer between 1 and 100"],
    [
      "DB_CONNECTION_TIMEOUT_MS",
      "99",
      "DB_CONNECTION_TIMEOUT_MS must be an integer between 100 and 60000",
    ],
    [
      "DB_STATEMENT_TIMEOUT_MS",
      "600001",
      "DB_STATEMENT_TIMEOUT_MS must be an integer between 100 and 600000",
    ],
    [
      "SHUTDOWN_TIMEOUT_MS",
      "999",
      "SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000",
    ],
  ])("rejects %s=%j", (name, value, expectedIssue) => {
    expect(configErrorFor({ DATABASE_URL: VALID_DATABASE_URL, [name]: value }).issues).toEqual([
      expectedIssue,
    ]);
  });

  it("reports every problem at once", () => {
    const error = configErrorFor({ PORT: "0", LOG_LEVEL: "loud", DB_POOL_MAX: "x" });

    expect(error.issues).toEqual([
      "PORT must be an integer between 1 and 65535",
      "LOG_LEVEL must be one of: fatal, error, warn, info, debug, trace, silent",
      "DATABASE_URL is required",
      "DB_POOL_MAX must be an integer between 1 and 100",
    ]);
    expect(error.message).toContain("Invalid configuration:");
  });
});

describe("loadConfigOrReport", () => {
  it("returns the configuration without reporting anything when it is valid", () => {
    const reports: string[] = [];

    const config = loadConfigOrReport({ DATABASE_URL: VALID_DATABASE_URL }, (message) =>
      reports.push(message),
    );

    expect(config?.database.url).toBe(VALID_DATABASE_URL);
    expect(reports).toEqual([]);
  });

  it("reports every problem and returns undefined when the configuration is invalid", () => {
    const reports: string[] = [];

    const config = loadConfigOrReport({ PORT: "x" }, (message) => reports.push(message));

    expect(config).toBeUndefined();
    expect(reports).toEqual([
      "Invalid configuration:\n- PORT must be an integer between 1 and 65535\n- DATABASE_URL is required",
    ]);
  });
});
