import { pino, type Logger } from "pino";
import { createLogger } from "../../src/shared/logger.js";

/** A logger that discards everything, for tests that do not assert on log output. */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}

/** The production logger (same redaction rules) writing JSON lines into memory. */
export function createCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger("info", { write: (line: string) => lines.push(line) }), lines };
}
