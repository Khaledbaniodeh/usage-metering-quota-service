/**
 * Seeds the benchmark dataset by direct SQL (dataset construction, never write-performance
 * evidence). Usage:
 *
 *   BENCH_DATABASE_URL=postgres://…/usage_metering_bench PROFILE=smoke|full SHAPE=s2|s3 \
 *   API_KEY_FILE=/absolute/path/outside/the/repo  node --import tsx load/scripts/seed.ts
 *
 * Refuses unless the database is a fresh "_bench" database. The heavy tenant's API key is written
 * only to API_KEY_FILE (mode 0600, never overwritten); nothing prints it. Seed metadata (IDs,
 * counts, timings) goes to RESULTS_DIR/seed.json.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { generateApiKey, hashApiKey } from "../../src/modules/auth/api-key.js";
import { benchDatabase, withBenchClient } from "../lib/bench-db.js";
import { Refusal, required, resultsDir, runMain, writeJson } from "../lib/cli.js";
import {
  OLDEST_MONTH_KEY,
  PROFILES,
  parseProfileName,
  parseShape,
  totalDecisions,
} from "../lib/profiles.js";
import { LABELS, seedStatements, TENANTS } from "../lib/seed-sql.js";

const env = process.env;
let password = "";

function keyFilePath(): string {
  const path = required(env, "API_KEY_FILE");
  const inside = relative(resolve("."), path);
  if (!isAbsolute(path) || !inside.startsWith("..")) {
    throw new Refusal("API_KEY_FILE must be an absolute path outside the repository");
  }
  return path;
}

async function main(): Promise<void> {
  const database = benchDatabase(env);
  password = database.password;
  const profile = PROFILES[parseProfileName(env.PROFILE)];
  const shape = parseShape(env.SHAPE);
  const keyFile = keyFilePath();
  const output = resultsDir(env);

  const heavyKey = generateApiKey();
  const statements = seedStatements(profile, shape, {
    heavyKeyHash: hashApiKey(heavyKey),
    // The noise tenant is never called over HTTP; its key is discarded.
    noiseKeyHash: hashApiKey(generateApiKey()),
  });

  const metadata = await withBenchClient(database, async (client) => {
    const existing = await client.query<{ rows: number }>(
      "SELECT (SELECT count(*) FROM accounts) + (SELECT count(*) FROM consume_decisions) AS rows",
    );
    if ((existing.rows[0]?.rows ?? -1) !== 0) {
      throw new Refusal("the benchmark database is not fresh (accounts or decisions exist)");
    }

    const timings: Record<string, number> = {};
    const started = performance.now();
    await client.query("BEGIN");
    try {
      // Dataset construction only: durability of the seed transaction is irrelevant.
      await client.query("SET LOCAL synchronous_commit = off");
      for (const statement of statements) {
        const before = performance.now();
        await client.query(statement.sql, [...statement.params]);
        timings[statement.label] = Math.round(performance.now() - before);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const insertMs = Math.round(performance.now() - started);
    const vacuumStarted = performance.now();
    await client.query(
      "VACUUM (ANALYZE) plans, accounts, users, account_monthly_usage, user_monthly_usage, consume_decisions",
    );
    await client.query("CHECKPOINT");
    const vacuumMs = Math.round(performance.now() - vacuumStarted);

    const ids = await client.query<{ account_id: string; user_id: string }>(
      "SELECT md5('umqs-bench:' || $1)::uuid AS account_id, md5('umqs-bench:' || $2)::uuid AS user_id",
      [LABELS.account(TENANTS.heavy.code), LABELS.heavyUser],
    );
    const counts = await client.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM accounts) AS accounts,
              (SELECT count(*) FROM users) AS users,
              (SELECT count(*) FROM consume_decisions) AS decisions,
              (SELECT count(*) FROM consume_decisions WHERE NOT accepted) AS rejected,
              (SELECT count(*) FROM consume_decisions WHERE user_id = $1) AS heavy_user_decisions,
              (SELECT count(*) FROM consume_decisions WHERE user_id = $1 AND month = $2) AS heavy_user_oldest_month,
              (SELECT count(*) FROM consume_decisions WHERE account_id = $3 AND month = $2) AS heavy_account_oldest_month,
              (SELECT count(DISTINCT month) FROM consume_decisions) AS months,
              (SELECT count(*) FROM account_monthly_usage) AS account_counters,
              (SELECT count(*) FROM user_monthly_usage) AS user_counters`,
      [ids.rows[0]?.user_id, `${OLDEST_MONTH_KEY}-01`, ids.rows[0]?.account_id],
    );
    const row = counts.rows[0] ?? {};
    return {
      schema: "umqs-bench-seed/1",
      profile: profile.name,
      shape,
      expectedDecisions: totalDecisions(profile),
      heavyAccountId: ids.rows[0]?.account_id,
      heavyUserId: ids.rows[0]?.user_id,
      oldestMonth: OLDEST_MONTH_KEY,
      counts: Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)])),
      timingsMs: { ...timings, insertTotal: insertMs, vacuumAnalyzeCheckpoint: vacuumMs },
    };
  });

  if (metadata.counts.decisions !== metadata.expectedDecisions) {
    throw new Error(
      `seeded ${String(metadata.counts.decisions)} decisions, expected ${String(metadata.expectedDecisions)}`,
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- API_KEY_FILE was validated as an absolute path outside the repository
  writeFileSync(keyFile, heavyKey, { mode: 0o600, flag: "wx" });
  writeJson(output, "seed.json", metadata);
  process.stdout.write(
    `seeded ${profile.name}/${shape}: ${String(metadata.counts.decisions)} decisions, ` +
      `${String(metadata.counts.users)} users, ${String(metadata.counts.months)} months in ` +
      `${String(metadata.timingsMs.insertTotal)} ms (+${String(metadata.timingsMs.vacuumAnalyzeCheckpoint)} ms vacuum/analyze)\n`,
  );
}

runMain(main, () => [password]);
