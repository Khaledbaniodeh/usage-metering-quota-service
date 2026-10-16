import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { redactSecrets } from "./redact.js";

/**
 * Shared plumbing of the load-test command-line scripts: one failure path that prints only a
 * redacted message (never a stack, which could carry connection details) and sets the exit code,
 * and a guarded results directory.
 */

export const EXIT_FAILURE = 1;
/** A safety refusal (disk projection, database guard) rather than a failed check. */
export const EXIT_REFUSED = 2;

export class Refusal extends Error {
  override readonly name = "Refusal";
}

export function runMain(
  main: () => Promise<void> | void,
  secrets: () => readonly string[] = () => [],
): void {
  // Starting from a resolved promise turns a synchronous throw into a rejection as well.
  Promise.resolve()
    .then(main)
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : "unexpected failure";
      process.stderr.write(`${redactSecrets(message, secrets())}\n`);
      process.exitCode = error instanceof Refusal ? EXIT_REFUSED : EXIT_FAILURE;
    });
}

/** The repository's ignored results directory, or an absolute RESULTS_DIR (CI scratch space). */
export function resultsDir(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.RESULTS_DIR?.trim();
  const directory =
    configured === undefined || configured === "" ? resolve("load/results") : configured;
  if (!isAbsolute(directory)) {
    throw new Refusal("RESULTS_DIR must be an absolute path");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the repository's load/results or an absolute RESULTS_DIR set by the workflow
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Writes pretty JSON with a trailing newline; returns the path. */
export function writeJson(directory: string, name: string, value: unknown): string {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name)) {
    throw new Refusal("result file names must be simple lower-case .json names");
  }
  const path = join(directory, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the directory is resultsDir() and the name was validated above
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** A required non-empty environment variable. */
export function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = new Map(Object.entries(env)).get(name)?.trim();
  if (value === undefined || value === "") {
    throw new Refusal(`${name} is required`);
  }
  return value;
}
