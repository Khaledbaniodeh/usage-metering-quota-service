/**
 * Checks every quota invariant directly in PostgreSQL after a seed or a write workload. Usage:
 *
 *   BENCH_DATABASE_URL=… RUN_LABEL=after-seed node --import tsx load/scripts/check-invariants.ts
 *
 * Uses the same catalogue as the integration tests (load/lib/invariant-queries.ts). With
 * MANIFESTS=<k6 summary path>[,…] it also compares each run's manifest with the decisions stored
 * under its request-ID prefix. Prints each check's count, writes RESULTS_DIR/invariants-<label>.json
 * and exits 1 on any violation.
 */
import { readFileSync } from "node:fs";
import { countInvariantViolations } from "../lib/invariant-queries.js";
import { manifestChecks, parseK6Summary, type ManifestCheck } from "../lib/k6-summary.js";
import { benchDatabase, withBenchClient } from "../lib/bench-db.js";
import { required, resultsDir, runMain, writeJson } from "../lib/cli.js";

const env = process.env;
let password = "";

async function main(): Promise<void> {
  const database = benchDatabase(env);
  password = database.password;
  const label = required(env, "RUN_LABEL");
  if (!/^[a-z0-9-]{1,40}$/.test(label)) {
    throw new Error("RUN_LABEL must be 1-40 characters of a-z, 0-9 and -");
  }
  const output = resultsDir(env);
  const started = performance.now();
  const manifests = (env.MANIFESTS ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- k6 summary paths given by the workflow
    .map((path) => parseK6Summary(JSON.parse(readFileSync(path, "utf8"))));
  const { violations, runs } = await withBenchClient(database, async (client) => {
    const counts = await countInvariantViolations(client);
    const checked: { runLabel: string; checks: ManifestCheck[] }[] = [];
    for (const summary of manifests) {
      const prefix = summary.manifest.requestIdPrefix;
      const stored = await client.query<{ total: number; accepted: number }>(
        `SELECT count(*)::int AS total, (count(*) FILTER (WHERE accepted))::int AS accepted
         FROM consume_decisions WHERE left(request_id, length($1)) = $1`,
        [prefix],
      );
      const row = stored.rows[0] ?? { total: -1, accepted: -1 };
      checked.push({ runLabel: summary.runLabel, checks: manifestChecks(summary.manifest, row) });
    }
    return { violations: counts, runs: checked };
  });
  const failedManifests = runs.flatMap((run) =>
    run.checks.filter((c) => !c.passed).map((c) => `${run.runLabel}: ${c.name}`),
  );
  const failed = Object.entries(violations).filter(([, count]) => count !== 0);
  writeJson(output, `invariants-${label}.json`, {
    schema: "umqs-bench-invariants/1",
    label,
    passed: failed.length === 0 && failedManifests.length === 0,
    durationMs: Math.round(performance.now() - started),
    violations,
    manifests: runs,
  });
  for (const [name, count] of Object.entries(violations)) {
    process.stdout.write(`${count === 0 ? "ok  " : "FAIL"} ${name}: ${String(count)}\n`);
  }
  for (const run of runs) {
    for (const c of run.checks) {
      process.stdout.write(
        `${c.passed ? "ok  " : "FAIL"} ${run.runLabel}: ${c.name} (expected ${String(c.expected)}, stored ${String(c.actual)})
`,
      );
    }
  }
  if (failedManifests.length > 0) {
    throw new Error(`run manifest mismatch: ${failedManifests.join("; ")}`);
  }
  if (failed.length > 0) {
    throw new Error(
      `${String(failed.length)} invariant(s) violated: ${failed.map(([name]) => name).join(", ")}`,
    );
  }
  process.stdout.write(`invariants ${label}: all ${String(Object.keys(violations).length)} hold\n`);
}

runMain(main, () => [password]);
