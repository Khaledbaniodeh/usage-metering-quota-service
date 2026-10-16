/**
 * Writes RESULTS_DIR/environment.json before any measurement. Usage (the workflow prepares the
 * three JSON inputs from docker and the tools themselves):
 *
 *   BENCH_DATABASE_URL=… COMMIT_SHA=… PROFILE=… SHAPE=… IMAGES_JSON=… TOOLS_JSON=… LIMITS_JSON=… \
 *   node --import tsx load/scripts/record-environment.ts
 *
 * IMAGES_JSON: { name: { reference, digest } }; TOOLS_JSON: { name: version };
 * LIMITS_JSON: { container: { nanoCpus, memoryBytes } } as read back from docker inspect.
 */
import { cpus, platform, release, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { benchDatabase, withBenchClient } from "../lib/bench-db.js";
import { required, resultsDir, runMain, writeJson } from "../lib/cli.js";
import {
  buildEnvironmentRecord,
  RECORDED_SETTINGS,
  type EnvironmentInput,
} from "../lib/environment.js";

const env = process.env;
let password = "";

function readJson(variable: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file the workflow wrote
  return JSON.parse(readFileSync(required(env, variable), "utf8"));
}

async function main(): Promise<void> {
  const database = benchDatabase(env);
  password = database.password;
  const output = resultsDir(env);
  const facts = await withBenchClient(database, async (client) => {
    const version = await client.query<{ version: string }>("SELECT version()");
    const settings = await client.query<{ name: string; value: string }>(
      `SELECT name, setting || coalesce(' ' || unit, '') AS value
       FROM pg_settings WHERE name = ANY($1::text[])`,
      [[...RECORDED_SETTINGS]],
    );
    return {
      version: version.rows[0]?.version ?? "",
      settings: Object.fromEntries(settings.rows.map((row) => [row.name, row.value])),
    };
  });
  const cpu = cpus();
  const record = buildEnvironmentRecord(
    {
      commitSha: required(env, "COMMIT_SHA"),
      profile: required(env, "PROFILE"),
      shape: required(env, "SHAPE"),
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpuModel: cpu[0]?.model ?? "unknown",
      cpuCount: cpu.length,
      totalMemoryBytes: totalmem(),
      images: readJson("IMAGES_JSON") as EnvironmentInput["images"],
      tools: readJson("TOOLS_JSON") as EnvironmentInput["tools"],
      limits: readJson("LIMITS_JSON") as EnvironmentInput["limits"],
      database: facts,
    },
    new Date(),
  );
  writeJson(output, "environment.json", record);
  process.stdout.write(
    `environment: ${record.cpuModel} × ${String(record.cpuCount)}, ` +
      `${(record.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB, node ${record.node}, ` +
      `${record.database.settings.server_version ?? "?"}\n`,
  );
}

runMain(main, () => [password]);
