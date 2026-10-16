/**
 * Records the database's disk footprint at one point of a run. Usage:
 *
 *   BENCH_DATABASE_URL=… RUN_LABEL=before-seed [DISK_PATH=/] node --import tsx load/scripts/measure-footprint.ts
 *
 * Writes RESULTS_DIR/footprint-<label>.json: pg_database_size, the size of every seeded table and
 * of each consume_decisions index, the current WAL position and pg_wal size, and the free bytes of
 * DISK_PATH's file system.
 */
import { statfsSync } from "node:fs";
import { benchDatabase, withBenchClient } from "../lib/bench-db.js";
import { required, resultsDir, runMain, writeJson } from "../lib/cli.js";

const env = process.env;
let password = "";

export const SEEDED_TABLES = [
  "plans",
  "accounts",
  "users",
  "account_monthly_usage",
  "user_monthly_usage",
  "consume_decisions",
] as const;

async function main(): Promise<void> {
  const database = benchDatabase(env);
  password = database.password;
  const label = required(env, "RUN_LABEL");
  if (!/^[a-z0-9-]{1,40}$/.test(label)) {
    throw new Error("RUN_LABEL must be 1-40 characters of a-z, 0-9 and -");
  }
  const output = resultsDir(env);
  const diskPath = env.DISK_PATH?.trim() ?? "/";

  const measured = await withBenchClient(database, async (client) => {
    const db = await client.query<{ bytes: string; lsn: string; wal_bytes: string }>(
      `SELECT pg_database_size(current_database())::text AS bytes,
              pg_current_wal_lsn()::text AS lsn,
              (SELECT coalesce(sum(size), 0) FROM pg_ls_waldir())::text AS wal_bytes`,
    );
    const tables = await client.query<{
      name: string;
      total: string;
      heap: string;
      indexes: string;
    }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS total,
              pg_relation_size(c.oid)::text AS heap, pg_indexes_size(c.oid)::text AS indexes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [[...SEEDED_TABLES]],
    );
    const indexes = await client.query<{ name: string; bytes: string }>(
      `SELECT i.indexrelid::regclass::text AS name, pg_relation_size(i.indexrelid)::text AS bytes
       FROM pg_index i WHERE i.indrelid = 'consume_decisions'::regclass ORDER BY 1`,
    );
    return { db: db.rows[0], tables: tables.rows, indexes: indexes.rows };
  });

  const fs = statfsSync(diskPath);
  const tables = Object.fromEntries(
    measured.tables.map((t) => [
      t.name,
      { total: Number(t.total), heap: Number(t.heap), indexes: Number(t.indexes) },
    ]),
  );
  const relationBytes = measured.tables.reduce((sum, t) => sum + Number(t.total), 0);
  writeJson(output, `footprint-${label}.json`, {
    schema: "umqs-bench-footprint/1",
    label,
    measuredAt: new Date().toISOString(),
    databaseBytes: Number(measured.db?.bytes ?? -1),
    relationBytes,
    tables,
    consumeDecisionIndexes: Object.fromEntries(
      measured.indexes.map((i) => [i.name, Number(i.bytes)]),
    ),
    walLsn: measured.db?.lsn,
    pgWalDirectoryBytes: Number(measured.db?.wal_bytes ?? -1),
    disk: { path: diskPath, freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize },
  });
  process.stdout.write(
    `footprint ${label}: database ${String(measured.db?.bytes)} B, seeded relations ${String(relationBytes)} B, ` +
      `pg_wal ${String(measured.db?.wal_bytes)} B, free ${String(fs.bavail * fs.bsize)} B\n`,
  );
}

runMain(main, () => [password]);
