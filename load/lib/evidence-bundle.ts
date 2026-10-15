import { existsSync, readdirSync } from "node:fs";
import { assembleDecision, type DecisionReport } from "./evidence.js";
import type { ExplainSummary } from "./explain.js";
import { parseK6Summary, type K6Summary } from "./k6-summary.js";
import type { ProfileName } from "./profiles.js";
import { findSecrets, redactSecrets } from "./redact.js";

/**
 * The evidence bundle built from one run's results directory: summary.json, decision.md,
 * environment.json and readable EXPLAIN text, redacted and then scanned.
 *
 * "complete" mode is the normal end of benchmark.sh. "partial" mode runs only after the benchmark
 * step failed: it reports whatever results exist, lists everything missing, tolerates malformed
 * files instead of aborting, and never computes a decision or any conclusion.
 */

export type EvidenceMode = "complete" | "partial";

export const EVIDENCE_SCHEMA = "umqs-bench-evidence/1";

/** Measured runs per profile, as benchmark.sh executes them. */
export const PROFILE_RUN_COUNTS: Readonly<Record<ProfileName, { history: number; gates: number }>> =
  {
    smoke: { history: 1, gates: 1 },
    full: { history: 3, gates: 5 },
  };

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index + 1)}`);

export interface ExpectedRuns {
  readonly history: readonly string[];
  readonly gates: readonly string[];
  readonly diagnostics: readonly string[];
  readonly races: readonly string[];
}

/** Every run label a complete benchmark of `profile` produces, in execution order per group. */
export function expectedRunLabels(profile: ProfileName): ExpectedRuns {
  const counts = profile === "full" ? PROFILE_RUN_COUNTS.full : PROFILE_RUN_COUNTS.smoke;
  return {
    history: numbered("hist-s2-a", counts.history),
    gates: numbered("ab-dist-a", counts.gates).flatMap((dist, index) => [
      dist,
      `ab-hot-a-${String(index + 1)}`,
    ]),
    diagnostics: ["diag-spread", "diag-account", "diag-user"],
    races: ["race-identical", "race-conflicting"],
  };
}

const BASE_FILES = [
  "environment.json",
  "seed.json",
  "footprint-before-seed.json",
  "footprint-after-seed.json",
  "footprint-after-workloads.json",
  "disk-projection.json",
  "disk-samples.json",
  "docker-usage.json",
  "explain-s2-a.json",
  "explain-s2-a.txt",
  "invariants-after-seed.json",
] as const;

export interface MissingEvidence {
  /** Runs without a k6 summary. */
  readonly runLabels: readonly string[];
  /** Expected result files that do not exist. */
  readonly files: readonly string[];
}

export function missingEvidence(profile: ProfileName, names: readonly string[]): MissingEvidence {
  const present = new Set(names);
  const runs = expectedRunLabels(profile);
  const all = [...runs.history, ...runs.gates, ...runs.diagnostics, ...runs.races];
  const writeRuns = [...runs.gates, ...runs.diagnostics, ...runs.races];
  const required = [
    ...BASE_FILES,
    ...all.map((label) => `k6-${label}.json`),
    ...writeRuns.map((label) => `invariants-${label}.json`),
  ];
  return {
    runLabels: all.filter((label) => !present.has(`k6-${label}.json`)),
    files: required.filter((name) => !present.has(name)),
  };
}

export interface ResultSource {
  /** File names in the results directory. */
  readonly names: readonly string[];
  readonly readJson: (name: string) => unknown;
  readonly readText: (name: string) => string;
}

export interface BundleInput {
  readonly profile: ProfileName;
  readonly commitSha: string;
  readonly mode: EvidenceMode;
  readonly source: ResultSource;
  /** Literal secrets to redact and scan for (database password, issued API key). */
  readonly secrets: readonly string[];
  readonly now: Date;
  /** False when the results directory did not exist at all (the run failed before any result). */
  readonly resultsDirectoryPresent?: boolean;
}

export interface EvidenceBundle {
  readonly files: ReadonlyMap<string, string>;
  readonly complete: boolean;
  readonly k6Runs: number;
  readonly explainSets: number;
  readonly decision: DecisionReport;
  readonly missing: MissingEvidence;
}

export class EvidenceError extends Error {
  override readonly name = "EvidenceError";
}

interface InvalidFile {
  readonly file: string;
  readonly reason: string;
}

export function buildEvidenceBundle(input: BundleInput): EvidenceBundle {
  const { source, mode } = input;
  const names = [...source.names].sort();
  const invalidFiles: InvalidFile[] = [];
  /** Strict in complete mode; in partial mode a bad file is recorded and skipped. */
  const attempt = <T>(file: string, parse: () => T): T | undefined => {
    try {
      return parse();
    } catch (error) {
      if (mode === "complete") {
        throw error;
      }
      invalidFiles.push({ file, reason: error instanceof Error ? error.message : "unreadable" });
      return undefined;
    }
  };
  const optional = (name: string): unknown =>
    names.includes(name) ? (attempt(name, () => source.readJson(name)) ?? null) : null;
  const matching = (pattern: RegExp) => names.filter((name) => pattern.test(name));

  const k6: K6Summary[] = matching(/^k6-.*\.json$/).flatMap((name) => {
    const parsed = attempt(name, () => parseK6Summary(source.readJson(name)));
    return parsed === undefined ? [] : [parsed];
  });
  const explains = Object.fromEntries(
    matching(/^explain-.*\.json$/).flatMap((name) => {
      const value = attempt(
        name,
        () =>
          source.readJson(name) as {
            label: string;
            firstAfterRestart: ExplainSummary;
            warm: ExplainSummary[];
            query: unknown;
          },
      );
      return value === undefined
        ? []
        : [
            [
              value.label,
              { query: value.query, firstAfterRestart: value.firstAfterRestart, warm: value.warm },
            ],
          ];
    }),
  );
  const invariants = Object.fromEntries(
    matching(/^invariants-.*\.json$/).flatMap((name) => {
      const value = attempt(
        name,
        () =>
          source.readJson(name) as {
            label: string;
            passed: boolean;
            violations: unknown;
            manifests?: unknown;
          },
      );
      return value === undefined
        ? []
        : [
            [
              value.label,
              {
                passed: value.passed,
                violations: value.violations,
                manifests: value.manifests ?? [],
              },
            ],
          ];
    }),
  );
  const pgStatStatements = Object.fromEntries(
    matching(/^pg-stat-statements-.*\.json$/).map((name) => [
      name.replace(/^pg-stat-statements-|\.json$/g, ""),
      optional(name),
    ]),
  );
  const footprints = Object.fromEntries(
    matching(/^footprint-.*\.json$/).map((name) => [name.replace(/\.json$/, ""), optional(name)]),
  );
  const k6ExitCodes = Object.fromEntries(
    matching(/^k6-exit-[a-z0-9-]+\.txt$/).map((name) => [
      name.replace(/^k6-exit-|\.txt$/g, ""),
      Number(source.readText(name).trim()),
    ]),
  );

  const missing = missingEvidence(input.profile, names);
  const decision: DecisionReport =
    mode === "partial"
      ? {
          computed: false,
          reason:
            "the benchmark step failed; this bundle is incomplete and draws no performance or index conclusion",
          missing: [...missing.runLabels, ...missing.files],
        }
      : assembleDecision({
          profile: input.profile,
          k6,
          explains,
          invariantsPassed: Object.fromEntries(
            Object.entries(invariants).map(([label, value]) => [label, value.passed]),
          ),
        });
  const complete = mode === "complete";
  const resultsDirectoryPresent = input.resultsDirectoryPresent ?? true;

  const summary = {
    schema: EVIDENCE_SCHEMA,
    complete,
    benchmarkStepFailed: !complete,
    resultsDirectoryPresent,
    commitSha: input.commitSha,
    profile: input.profile,
    generatedAt: input.now.toISOString(),
    missing,
    invalidFiles,
    k6ExitCodes,
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

  const rows = k6.map((run) => {
    const p95 = run.measured.primaryDurationMs?.p95;
    return `| ${run.runLabel} | ${run.workload} | ${run.thresholdsPassed ? "passed" : "FAILED"} | ${String(run.measured.iterations)} | ${String(run.measured.droppedIterations)} | ${p95 === undefined ? "n/a" : p95.toFixed(2)} | ${String(run.measured.outcomes.unexpected)} | ${String(run.measured.outcomes.busyRetry)} |`;
  });
  const list = (items: readonly string[]) => (items.length === 0 ? "none" : items.join(", "));
  const table = [
    complete
      ? `# Benchmark evidence (${input.profile})`
      : `# Benchmark evidence (${input.profile}): INCOMPLETE`,
    "",
    complete
      ? `Commit \`${input.commitSha}\`. Every run is listed; none is dropped.`
      : `Commit \`${input.commitSha}\`. **The benchmark step failed.** This bundle holds only the results that exist. It draws **no performance or index conclusion**.`,
    "",
    "| Run | Workload | Thresholds | Measured iterations | Dropped | Primary p95 (ms) | Unexpected | BUSY_RETRY |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...(complete
      ? []
      : [
          "## Missing or invalid evidence",
          "",
          ...(resultsDirectoryPresent
            ? []
            : [
                "- The results directory did not exist: the benchmark failed before producing any result.",
              ]),
          `- Runs without a k6 summary: ${list(missing.runLabels)}`,
          `- Missing result files: ${list(missing.files)}`,
          `- Invalid result files: ${list(invalidFiles.map((f) => f.file))}`,
          "",
        ]),
    "## Decision",
    "",
    decision.computed
      ? [
          `Eligible: **${decision.decision.eligible ? "yes" : "no"}**`,
          "",
          ...decision.decision.reasons.map((r) => `- ${r}`),
        ].join("\n")
      : `Not computed: ${decision.reason}${complete && decision.missing.length > 0 ? ` (missing: ${decision.missing.join(", ")})` : ""}.`,
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
  for (const name of matching(/^explain-[a-z0-9-]+\.txt$/)) {
    files.set(name, source.readText(name));
  }

  const redacted = new Map(
    [...files].map(([name, content]) => [name, redactSecrets(content, input.secrets)]),
  );
  const findings = [...redacted].flatMap(([name, content]) =>
    findSecrets(content, input.secrets).map((f) => `${name}:${String(f.line)} ${f.kind}`),
  );
  if (findings.length > 0) {
    throw new EvidenceError(`secrets remain after redaction: ${findings.join(", ")}`);
  }
  return {
    files: redacted,
    complete,
    k6Runs: k6.length,
    explainSets: Object.keys(explains).length,
    decision,
    missing,
  };
}

/** Never overwrites: the evidence directory must not exist yet or be empty. */
export function assertEvidenceDirectoryFree(path: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- EVIDENCE_DIR, validated as absolute by the caller
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new EvidenceError("EVIDENCE_DIR already holds evidence; it is never overwritten");
  }
}
