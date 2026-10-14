/**
 * Checks every quota invariant directly in PostgreSQL after a seed or a write workload. Usage:
 *
 *   BENCH_DATABASE_URL=… RUN_LABEL=after-seed node --import tsx load/scripts/check-invariants.ts
 *
 * Uses the same catalogue as the integration tests (load/lib/invariant-queries.ts). Prints each
 * invariant's violation count, writes RESULTS_DIR/invariants-<label>.json and exits 1 on any
 * violation.
 */
import { countInvariantViolations } from "../lib/invariant-queries.js";
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
  const violations = await withBenchClient(database, (client) => countInvariantViolations(client));
  const failed = Object.entries(violations).filter(([, count]) => count !== 0);
  writeJson(output, `invariants-${label}.json`, {
    schema: "umqs-bench-invariants/1",
    label,
    passed: failed.length === 0,
    durationMs: Math.round(performance.now() - started),
    violations,
  });
  for (const [name, count] of Object.entries(violations)) {
    process.stdout.write(`${count === 0 ? "ok  " : "FAIL"} ${name}: ${String(count)}\n`);
  }
  if (failed.length > 0) {
    throw new Error(
      `${String(failed.length)} invariant(s) violated: ${failed.map(([name]) => name).join(", ")}`,
    );
  }
  process.stdout.write(`invariants ${label}: all ${String(Object.keys(violations).length)} hold\n`);
}

runMain(main, () => [password]);
