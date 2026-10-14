/**
 * EXPLAIN evidence for the first page of the heavy user's oldest month (GET /v1/history?userId=…&
 * month=2025-01&limit=20). Usage, right after restarting PostgreSQL:
 *
 *   BENCH_DATABASE_URL=… RUN_LABEL=s2-baseline node --import tsx load/scripts/explain-history.ts
 *
 * Runs the production statement (captured from the repository) 1 + 5 times with
 * EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON): the first execution after the restart, then
 * five warm executions. The first is not called "cold": the operating-system cache is not cleared.
 * A readable text plan is captured last. Reads RESULTS_DIR/seed.json for the IDs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchDatabase, withBenchClient } from "../lib/bench-db.js";
import { required, resultsDir, runMain, writeJson } from "../lib/cli.js";
import { summarizeExplain, type ExplainSummary } from "../lib/explain.js";
import { firstHistoryPageQuery } from "../lib/history-query.js";
import { HISTORY_PAGE_LIMIT } from "../lib/profiles.js";
import { WARM_EXPLAIN_RUNS } from "../lib/stats.js";

const env = process.env;
let password = "";

interface SeedMetadata {
  readonly heavyAccountId: string;
  readonly heavyUserId: string;
  readonly oldestMonth: string;
}

async function main(): Promise<void> {
  const database = benchDatabase(env);
  password = database.password;
  const label = required(env, "RUN_LABEL");
  if (!/^[a-z0-9-]{1,40}$/.test(label)) {
    throw new Error("RUN_LABEL must be 1-40 characters of a-z, 0-9 and -");
  }
  const output = resultsDir(env);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed name inside resultsDir()
  const seed = JSON.parse(readFileSync(join(output, "seed.json"), "utf8")) as SeedMetadata;
  const query = await firstHistoryPageQuery(
    seed.heavyAccountId,
    seed.heavyUserId,
    seed.oldestMonth,
    HISTORY_PAGE_LIMIT,
  );

  const { plans, text } = await withBenchClient(database, async (client) => {
    // Production sends unnamed statements, which PostgreSQL plans with the actual values on
    // every execution. A prepared statement would switch to a generic plan after five runs, so
    // custom planning is kept; this reproduces production and does not steer the plan choice.
    await client.query("SET plan_cache_mode = force_custom_plan");
    await client.query(`PREPARE history_first_page AS ${query.sql}`);
    const args = query.params
      .map((value) =>
        typeof value === "number" ? String(value) : client.escapeLiteral(String(value)),
      )
      .join(", ");
    const execute = (options: string) =>
      client.query<Record<string, unknown>>(
        `EXPLAIN (${options}) EXECUTE history_first_page(${args})`,
      );
    const raw: unknown[] = [];
    for (let run = 0; run <= WARM_EXPLAIN_RUNS; run += 1) {
      const result = await execute("ANALYZE, BUFFERS, SETTINGS, FORMAT JSON");
      raw.push(result.rows[0]?.["QUERY PLAN"]);
    }
    const textPlan = await execute("ANALYZE, BUFFERS, SETTINGS");
    return {
      plans: raw,
      text: textPlan.rows.map((row) => String(row["QUERY PLAN"])).join("\n"),
    };
  });

  const summaries: ExplainSummary[] = plans.map((plan) => summarizeExplain(plan));
  const [first, ...warm] = summaries;
  writeJson(output, `explain-${label}.json`, {
    schema: "umqs-bench-explain/1",
    label,
    query: { sql: query.sql, params: query.params, limit: HISTORY_PAGE_LIMIT },
    firstAfterRestart: first,
    warm,
    rawPlans: plans,
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- label validated above, inside resultsDir()
  writeFileSync(join(output, `explain-${label}.txt`), `${text}\n`);
  process.stdout.write(
    `explain ${label}: first-after-restart ${String(first?.executionMs)} ms; warm ` +
      `${warm.map((s) => `${String(s.executionMs)} ms/${String(s.rowsRemovedByFilter)} removed`).join(", ")}; ` +
      `plan ${first?.scans.join(" > ") ?? "?"}${first?.sorts === true ? " + sort" : ""}\n`,
  );
}

runMain(main, () => [password]);
