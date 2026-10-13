import { pino, type Logger } from "pino";

/** A logger that discards everything, for tests that do not assert on log output. */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
