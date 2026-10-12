import { pino, type Logger } from "pino";
import type { LogLevel } from "../config/config.js";

/**
 * Paths removed from every log line. Request headers are not logged by Fastify's default
 * serializers; these paths are a second line of defense in case a header, a database URL or a
 * credential is ever attached to a log object.
 */
const REDACTED_PATHS = [
  'req.headers["x-api-key"]',
  "req.headers.authorization",
  "req.headers.cookie",
  "databaseUrl",
  "connectionString",
  "password",
  "*.databaseUrl",
  "*.connectionString",
  "*.password",
];

export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    base: { service: "usage-metering-quota-service" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  });
}
