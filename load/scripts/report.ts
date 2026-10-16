/**
 * Builds the small, redacted evidence bundle from one run's generated results. Usage:
 *
 *   PROFILE=smoke|full COMMIT_SHA=… EVIDENCE_DIR=/absolute/dir [REPORT_MODE=complete|partial] \
 *   [RESULTS_DIR=…] [BENCH_DATABASE_URL=…] [API_KEY_FILE=…] node --import tsx load/scripts/report.ts
 *
 * Writes to EVIDENCE_DIR (load/lib/evidence-bundle.ts):
 *   summary.json        complete flag, missing and invalid evidence, k6 exit codes, environment,
 *                       seed counts, footprints, disk projection and samples, Docker usage,
 *                       EXPLAIN summaries, every k6 run and every invariant result
 *   environment.json    the environment record
 *   explain-<label>.txt readable EXPLAIN plans
 *   decision.md         the Markdown table and the decision, or why none is computed
 *
 * REPORT_MODE=partial is used only after a failed benchmark step: the bundle is marked
 * incomplete and never computes a decision. A RESULTS_DIR that does not exist still yields a
 * bundle, recorded as resultsDirectoryPresent: false, with every run and file listed as missing.
 * Needs no database: it reads result files only.
 * Every file is redacted and then scanned; any finding fails the report and nothing is written.
 * An existing, non-empty EVIDENCE_DIR is never overwritten.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { benchDatabase } from "../lib/bench-db.js";
import { Refusal, required, resultsDir, runMain } from "../lib/cli.js";
import {
  assertEvidenceDirectoryFree,
  buildEvidenceBundle,
  type EvidenceMode,
} from "../lib/evidence-bundle.js";
import { parseProfileName } from "../lib/profiles.js";

const env = process.env;

function secrets(): string[] {
  const values: string[] = [];
  if (env.BENCH_DATABASE_URL !== undefined) {
    values.push(benchDatabase(env).password);
  }
  if (env.API_KEY_FILE !== undefined) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the key file the seed wrote
      values.push(readFileSync(env.API_KEY_FILE, "utf8").trim());
    } catch {
      // No key exists (never issued, or already removed); pattern redaction still applies.
    }
  }
  return values;
}

function mode(): EvidenceMode {
  const raw = env.REPORT_MODE?.trim() ?? "complete";
  if (raw !== "complete" && raw !== "partial") {
    throw new Refusal("REPORT_MODE must be complete or partial");
  }
  return raw;
}

function main(): void {
  const profile = parseProfileName(env.PROFILE);
  const commitSha = required(env, "COMMIT_SHA");
  const evidence = required(env, "EVIDENCE_DIR");
  if (!isAbsolute(evidence)) {
    throw new Refusal("EVIDENCE_DIR must be an absolute path");
  }
  assertEvidenceDirectoryFree(evidence);
  // Recorded before resultsDir() creates the directory: an absent directory means no result at all.
  const configured = env.RESULTS_DIR?.trim() ?? "";
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- RESULTS_DIR set by the workflow; resultsDir() validates it next
  const configuredExists = configured !== "" && existsSync(configured);
  const resultsDirectoryPresent = configured === "" || configuredExists;
  const results = resultsDir(env);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resultsDir()
  const names = readdirSync(results);
  const readText = (name: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file listed in resultsDir()
    readFileSync(join(results, name), "utf8");

  const bundle = buildEvidenceBundle({
    profile,
    commitSha,
    mode: mode(),
    source: { names, readText, readJson: (name) => JSON.parse(readText(name)) as unknown },
    secrets: secrets(),
    now: new Date(),
    resultsDirectoryPresent,
  });

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- EVIDENCE_DIR validated as absolute and free
  mkdirSync(evidence, { recursive: true });
  for (const [name, content] of bundle.files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed or validated names
    writeFileSync(join(evidence, name), content);
  }
  process.stdout.write(
    `evidence (${bundle.complete ? "complete" : "INCOMPLETE"}): ${String(bundle.files.size)} files, ` +
      `${String(bundle.k6Runs)} k6 runs, ${String(bundle.explainSets)} EXPLAIN sets, ` +
      `${String(bundle.missing.runLabels.length)} runs and ${String(bundle.missing.files.length)} files missing, ` +
      `decision ${bundle.decision.computed ? "computed" : "not computed"}\n`,
  );
}

runMain(main, secrets);
