/**
 * Centralized runtime configuration.
 *
 * Every environment variable the service reads is parsed and validated here, once, at startup.
 * Invalid or missing required values abort startup with a ConfigError that lists every problem.
 * Error messages never echo raw values, because some of them (DATABASE_URL) contain credentials.
 */

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface DatabaseConfig {
  /** PostgreSQL connection URL. Contains credentials: never log it. */
  readonly url: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface AppConfig {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly shutdownTimeoutMs: number;
  readonly database: DatabaseConfig;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

interface IntegerRule {
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}

const DATABASE_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const INTEGER_PATTERN = /^\d+$/;

export function loadConfig(env: Environment): AppConfig {
  const issues: string[] = [];

  const config: AppConfig = {
    port: readInteger("PORT", env.PORT, { defaultValue: 8080, min: 1, max: 65_535 }, issues),
    logLevel: readLogLevel(env.LOG_LEVEL, issues),
    shutdownTimeoutMs: readInteger(
      "SHUTDOWN_TIMEOUT_MS",
      env.SHUTDOWN_TIMEOUT_MS,
      { defaultValue: 10_000, min: 1_000, max: 120_000 },
      issues,
    ),
    database: {
      url: readDatabaseUrl(env.DATABASE_URL, issues),
      poolMax: readInteger(
        "DB_POOL_MAX",
        env.DB_POOL_MAX,
        { defaultValue: 10, min: 1, max: 100 },
        issues,
      ),
      connectionTimeoutMs: readInteger(
        "DB_CONNECTION_TIMEOUT_MS",
        env.DB_CONNECTION_TIMEOUT_MS,
        { defaultValue: 5_000, min: 100, max: 60_000 },
        issues,
      ),
      statementTimeoutMs: readInteger(
        "DB_STATEMENT_TIMEOUT_MS",
        env.DB_STATEMENT_TIMEOUT_MS,
        { defaultValue: 5_000, min: 100, max: 600_000 },
        issues,
      ),
    },
  };

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
  return config;
}

function readInteger(
  name: string,
  raw: string | undefined,
  rule: IntegerRule,
  issues: string[],
): number {
  if (raw === undefined || raw === "") {
    return rule.defaultValue;
  }
  const value = INTEGER_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
    issues.push(`${name} must be an integer between ${String(rule.min)} and ${String(rule.max)}`);
    return rule.defaultValue;
  }
  return value;
}

function readLogLevel(raw: string | undefined, issues: string[]): LogLevel {
  if (raw === undefined || raw === "") {
    return "info";
  }
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    issues.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
    return "info";
  }
  return level;
}

function readDatabaseUrl(raw: string | undefined, issues: string[]): string {
  if (raw === undefined || raw === "") {
    issues.push("DATABASE_URL is required");
    return "";
  }
  const problem = describeDatabaseUrlProblem(raw);
  if (problem !== undefined) {
    issues.push(`DATABASE_URL ${problem}`);
    return "";
  }
  return raw;
}

function describeDatabaseUrlProblem(raw: string): string | undefined {
  if (/\s/.test(raw)) {
    return "must not contain whitespace";
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a valid URL";
  }
  if (!DATABASE_PROTOCOLS.has(url.protocol)) {
    return "must use the postgres:// or postgresql:// scheme";
  }
  if (url.hostname === "") {
    return "must include a host name";
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return "must contain a valid URL-encoded database name";
  }
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    return "must name a database using letters, digits, underscores or hyphens";
  }
  return undefined;
}
