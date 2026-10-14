/**
 * Builds the small, redacted evidence bundle from one run's generated results. Usage:
 *
 *   PROFILE=smoke|full COMMIT_SHA=… EVIDENCE_DIR=/absolute/dir [RESULTS_DIR=…] \
 *   [BENCH_DATABASE_URL=…] [API_KEY_FILE=…] node --import tsx load/scripts/report.ts
 *
 * Validates every k6 summary against its schema, then writes to EVIDENCE_DIR:
 *   summary.json        environment, seed counts, footprint, disk projection and samples, Docker
 *                       usage, EXPLAIN summaries,
 *                       every k6 run (each value kept, none dropped) and every invariant result
 *   environment.json    the environment record
 *   explain-<label>.txt readable EXPLAIN plans
 *   decision.md         the Markdown decision table (or why no decision is computed)
 * Every file is redacted and then scanned; any finding fails the report and nothing is kept.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { benchDatabase } from "../lib/bench-db.js";
import { Refusal, required, resultsDir, runMain } from "../lib/cli.js";
import { assembleDecision } from "../lib/evidence.js";
import type { ExplainSummary } from "../lib/explain.js";
import { parseK6Summary, type K6Summary } from "../lib/k6-summary.js";
import { findSecrets, redactSecrets } from "../lib/redact.js";

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
      // No key was issued; pattern redaction still applies.
    }
  }
  return values;
}

function main(): void {
  const profile = required(env, "PROFILE");
  const commitSha = required(env, "COMMIT_SHA");
  const evidence = required(env, "EVIDENCE_DIR");
  if (!isAbsolute(evidence)) {
    throw new Refusal("EVIDENCE_DIR must be an absolute path");
  }
  const results = resultsDir(env);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resultsDir()
  const names = readdirSync(results).sort();
  const read = (name: string): unknown =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file listed in resultsDir()
    JSON.parse(readFileSync(join(results, name), "utf8"));
  const optional = (name: string): unknown => (names.includes(name) ? read(name) : null);

  const k6: K6Summary[] = names
    .filter((n) => /^k6-.*\.json$/.test(n))
    .map((n) => parseK6Summary(read(n)));
  const explains = Object.fromEntries(
    names
      .filter((n) => /^explain-.*\.json$/.test(n))
      .map((n) => {
        const value = read(n) as {
          label: string;
          firstAfterRestart: ExplainSummary;
          warm: ExplainSummary[];
          query: unknown;
        };
        return [
          value.label,
          { query: value.query, firstAfterRestart: value.firstAfterRestart, warm: value.warm },
        ];
      }),
  );
  const invariants = Object.fromEntries(
    names
      .filter((n) => /^invariants-.*\.json$/.test(n))
      .map((n) => {
        const value = read(n) as {
          label: string;
          passed: boolean;
          violations: unknown;
          manifests?: unknown;
        };
        return [
          value.label,
          { passed: value.passed, violations: value.violations, manifests: value.manifests ?? [] },
        ];
      }),
  );
  const pgStatStatements = Object.fromEntries(
    names
      .filter((n) => /^pg-stat-statements-.*.json$/.test(n))
      .map((n) => [n.replace(/^pg-stat-statements-|.json$/g, ""), read(n)]),
  );
  const footprints = Object.fromEntries(
    names
      .filter((n) => /^footprint-.*\.json$/.test(n))
      .map((n) => [n.replace(/\.json$/, ""), read(n)]),
  );
  const decision = assembleDecision({
    profile,
    k6,
    explains,
    invariantsPassed: Object.fromEntries(
      Object.entries(invariants).map(([label, value]) => [label, value.passed]),
    ),
  });

  const summary = {
    schema: "umqs-bench-evidence/1",
    commitSha,
    profile,
    generatedAt: new Date().toISOString(),
    seed: optional("seed.json"),
    footprints,
    diskProjection: optional("disk-projection.json"),
    diskSamples: optional("disk-samples.json"),
    dockerUsage: optional("docker-usage.json"),
    explains,
    k6Runs: k6,
    invariants,
    pgStatStatements,
    decision,
  };
  const table = [
    `# Benchmark evidence (${profile})`,
    "",
    `Commit \`${commitSha}\`. Every run is listed; none is dropped.`,
    "",
    "| Run | Workload | Thresholds | Measured iterations | Dropped | Primary p95 (ms) | Unexpected | BUSY_RETRY |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...k6.map((run) => {
      const p95 = run.measured.primaryDurationMs?.p95;
      return `| ${run.runLabel} | ${run.workload} | ${run.thresholdsPassed ? "passed" : "FAILED"} | ${String(run.measured.iterations)} | ${String(run.measured.droppedIterations)} | ${p95 === undefined ? "n/a" : p95.toFixed(2)} | ${String(run.measured.outcomes.unexpected)} | ${String(run.measured.outcomes.busyRetry)} |`;
    }),
    "",
    "## Decision",
    "",
    decision.computed
      ? [
          `Eligible: **${decision.decision.eligible ? "yes" : "no"}**`,
          "",
          ...decision.decision.reasons.map((r) => `- ${r}`),
        ].join("\n")
      : `Not computed: ${decision.reason}${decision.missing.length > 0 ? ` (missing: ${decision.missing.join(", ")})` : ""}.`,
    "",
  ].join("\n");

  const files = new Map<string, string>([
    ["summary.json", `${JSON.stringify(summary, null, 2)}\n`],
    ["decision.md", table],
  ]);
  const environment = optional("environment.json");
  if (environment !== null) {
    files.set("environment.json", `${JSON.stringify(environment, null, 2)}\n`);
  }
  for (const name of names.filter((n) => /^explain-[a-z0-9-]+\.txt$/.test(n))) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file listed in resultsDir()
    files.set(name, readFileSync(join(results, name), "utf8"));
  }

  const literal = secrets();
  const redacted = new Map(
    [...files].map(([name, content]) => [name, redactSecrets(content, literal)]),
  );
  const findings = [...redacted].flatMap(([name, content]) =>
    findSecrets(content, literal).map((f) => `${name}:${String(f.line)} ${f.kind}`),
  );
  if (findings.length > 0) {
    throw new Error(`secrets remain after redaction: ${findings.join(", ")}`);
  }
  // Never deletes anything: the evidence directory must be new or empty.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- EVIDENCE_DIR validated as absolute
  if (existsSync(evidence) && readdirSync(evidence).length > 0) {
    throw new Refusal("EVIDENCE_DIR must not exist yet or be empty");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
  mkdirSync(evidence, { recursive: true });
  for (const [name, content] of redacted) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed or validated names
    writeFileSync(join(evidence, name), content);
  }
  process.stdout.write(
    `evidence: ${String(redacted.size)} files, ${String(k6.length)} k6 runs, ` +
      `${String(Object.keys(explains).length)} EXPLAIN sets, decision ${decision.computed ? "computed" : "not computed"}\n`,
  );
}

runMain(main, secrets);
