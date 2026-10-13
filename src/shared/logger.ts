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

/** Creates the structured JSON logger; `destination` defaults to stdout. */
export function createLogger(level: LogLevel, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: "usage-metering-quota-service" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
