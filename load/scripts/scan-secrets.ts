/**
 * Scans files and directories for secrets before anything is printed or uploaded. Usage:
 *
 *   [BENCH_DATABASE_URL=…] [API_KEY_FILE=…] node --import tsx load/scripts/scan-secrets.ts <path>…
 *
 * Looks for API-key-shaped tokens, passwords inside PostgreSQL URLs, and the literal values of the
 * benchmark database password and the issued API key. Prints only file, line and kind; exits 1 on
 * any finding.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { benchDatabase } from "../lib/bench-db.js";
import { runMain } from "../lib/cli.js";
import { findSecrets } from "../lib/redact.js";

const env = process.env;

function literals(): string[] {
  const values: string[] = [];
  if (env.BENCH_DATABASE_URL !== undefined) {
    values.push(benchDatabase(env).password);
  }
  if (env.API_KEY_FILE !== undefined) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the key file the seed wrote
      values.push(readFileSync(env.API_KEY_FILE, "utf8").trim());
    } catch {
      // No key was issued (for example the seed failed); the pattern scan still runs.
    }
  }
  return values;
}

function files(path: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths given on the command line by the workflow
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error("give at least one file or directory to scan");
  }
  const secrets = literals();
  let scanned = 0;
  let found = 0;
  for (const file of paths.flatMap(files)) {
    scanned += 1;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
    for (const finding of findSecrets(readFileSync(file, "utf8"), secrets)) {
      found += 1;
      process.stdout.write(`SECRET ${finding.kind} in ${file}:${String(finding.line)}\n`);
    }
  }
  process.stdout.write(`secret scan: ${String(scanned)} files, ${String(found)} findings\n`);
  if (found > 0) {
    throw new Error("secrets found; nothing may be printed or uploaded");
  }
}

runMain(main);
