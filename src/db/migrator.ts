import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Logger } from "pino";
import { APPLICATION_NAME } from "./pool.js";
import { typeParsers } from "./type-parsers.js";

/**
 * Forward-only SQL migration runner, shared by application startup and the db:migrate CLI.
 *
 * Algorithm:
 *  1. Load NNNN_name.sql files in byte order and compute a SHA-256 checksum of each (CRLF is
 *     normalized to LF first, so a checkout's line endings never look like a modification).
 *  2. On a dedicated connection, take a session-level advisory lock so that concurrently starting
 *     instances migrate one at a time; the others wait, then find nothing left to do.
 *  3. Verify that the already-applied migrations are exactly the first N files, with identical
 *     checksums. Any edited, removed or reordered migration aborts the run before changes are made.
 *  4. Apply each pending migration and record it in schema_migrations inside one transaction.
 *  5. Release the lock and close the connection whether the run succeeded or failed.
 *
 * Migration SQL is trusted repository content and never contains interpolated values; every
 * value the runner itself sends is a bound parameter.
 */

export interface Migration {
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

export type MigrationStatus =
  | { readonly state: "current" }
  | { readonly state: "pending"; readonly pending: readonly string[] }
  | { readonly state: "diverged"; readonly reason: string };

export interface MigrateOptions {
  readonly connectionString: string;
  readonly connectionTimeoutMs: number;
  readonly migrations: readonly Migration[];
  readonly logger: Logger;
  /** Maximum time to wait for the migration lock or for any lock a migration needs. */
  readonly lockTimeoutMs?: number;
}

export interface MigrateResult {
  /** Names of the migrations applied by this run (empty when the schema was already current). */
  readonly applied: readonly string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("./migrations/", import.meta.url),
);

/** Arbitrary constant that identifies this service's migration lock among all advisory locks. */
export const MIGRATION_LOCK_KEY = 7_302_026_101;

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

const CREATE_SCHEMA_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY CHECK (name ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'),
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function compareByteOrder(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export async function loadMigrations(
  directory: string = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<readonly Migration[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the directory is chosen by trusted code (the bundled migrations folder or a test fixture), never by request input
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareByteOrder);

  const invalid = names.filter((name) => !MIGRATION_FILE_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new MigrationError(
      `Invalid migration file name(s): ${invalid.join(", ")}. Expected NNNN_lowercase_name.sql`,
    );
  }

  const prefixes = new Set<string>();
  for (const name of names) {
    const prefix = name.slice(0, 4);
    if (prefixes.has(prefix)) {
      throw new MigrationError(`More than one migration uses the number ${prefix}`);
    }
    prefixes.add(prefix);
  }

  return Promise.all(
    names.map(async (name) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the name matched MIGRATION_FILE_PATTERN and comes from listing the trusted migrations directory
      const content = await readFile(join(directory, name), "utf8");
      const sql = content.replaceAll("\r\n", "\n");
      return { name, sql, checksum: checksumOf(sql) };
    }),
  );
}

/** Compares the migrations recorded in the database with the migrations shipped in this build. */
export function compareMigrations(
  applied: readonly AppliedMigration[],
  expected: readonly Migration[],
): MigrationStatus {
  if (applied.length > expected.length) {
    return {
      state: "diverged",
      reason: `The database has ${String(applied.length)} applied migrations but this build only knows ${String(expected.length)}`,
    };
  }
  for (const [index, record] of applied.entries()) {
    const migration = expected.at(index);
    if (migration?.name !== record.name) {
      return {
        state: "diverged",
        reason: `Applied migration ${record.name} does not match the expected migration ${migration?.name ?? "(none)"} at position ${String(index + 1)}`,
      };
    }
    if (migration.checksum !== record.checksum) {
      return {
        state: "diverged",
        reason: `Migration ${record.name} was modified after it was applied (checksum mismatch)`,
      };
    }
  }
  const pending = expected.slice(applied.length).map((migration) => migration.name);
  return pending.length === 0 ? { state: "current" } : { state: "pending", pending };
}

type Queryable = Pick<pg.ClientBase, "query">;

/** Returns the applied migrations in order, or null when schema_migrations does not exist yet. */
export async function readAppliedMigrations(
  db: Queryable,
): Promise<readonly AppliedMigration[] | null> {
  const table = await db.query<{ exists: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS exists",
  );
  if (table.rows[0]?.exists !== true) {
    return null;
  }
  const result = await db.query<AppliedMigration>(
    "SELECT name, checksum FROM schema_migrations ORDER BY name",
  );
  return result.rows;
}

export async function getMigrationStatus(
  db: Queryable,
  expected: readonly Migration[],
): Promise<MigrationStatus> {
  const applied = await readAppliedMigrations(db);
  return compareMigrations(applied ?? [], expected);
}

export async function migrateDatabase(options: MigrateOptions): Promise<MigrateResult> {
  const { logger } = options;
  const client = new pg.Client({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    application_name: `${APPLICATION_NAME}:migrator`,
    types: typeParsers,
  });
  client.on("error", (error) => {
    logger.error({ err: error }, "PostgreSQL error on the migration connection");
  });

  await client.connect();
  try {
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      `${String(lockTimeoutMs)}ms`,
    ]);
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    try {
      return await applyPendingMigrations(client, options.migrations, logger);
    } finally {
      await releaseMigrationLock(client, logger);
    }
  } finally {
    await client.end();
  }
}

async function applyPendingMigrations(
  client: pg.Client,
  migrations: readonly Migration[],
  logger: Logger,
): Promise<MigrateResult> {
  await client.query(CREATE_SCHEMA_MIGRATIONS_TABLE);
  const applied = (await readAppliedMigrations(client)) ?? [];
  const status = compareMigrations(applied, migrations);
  if (status.state === "diverged") {
    throw new MigrationError(status.reason);
  }

  const pending = migrations.slice(applied.length);
  for (const migration of pending) {
    await applyMigration(client, migration, logger);
  }
  return { applied: pending.map((migration) => migration.name) };
}

async function applyMigration(
  client: pg.Client,
  migration: Migration,
  logger: Logger,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
      migration.name,
      migration.checksum,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, "rollback of a failed migration failed");
    }
    throw new MigrationError(`Migration ${migration.name} failed and was rolled back`, {
      cause: error,
    });
  }
  logger.info({ migration: migration.name }, "applied database migration");
}

async function releaseMigrationLock(client: pg.Client, logger: Logger): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
  } catch (error) {
    // Closing the connection, which always follows, releases a session-level lock as well.
    logger.warn({ err: error }, "could not release the migration lock explicitly");
  }
}
