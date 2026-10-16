import pg from "pg";

/**
 * The benchmark database guard. Load scripts connect only through BENCH_DATABASE_URL, only to a
 * loopback host, and only to a database whose name ends in "_bench", so no development, test or
 * production database (for example one named in .env) can be seeded or measured by mistake. Error
 * messages never echo the URL, which contains the password.
 */

export const BENCH_DATABASE_SUFFIX = "_bench";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class BenchDatabaseError extends Error {
  override readonly name = "BenchDatabaseError";
}

export interface BenchDatabase {
  readonly url: string;
  readonly databaseName: string;
  /** The password, for redaction; empty when the URL has none. */
  readonly password: string;
}

export function benchDatabase(env: Readonly<Record<string, string | undefined>>): BenchDatabase {
  const raw = env.BENCH_DATABASE_URL;
  if (raw === undefined || raw.trim() === "") {
    throw new BenchDatabaseError("BENCH_DATABASE_URL is required");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BenchDatabaseError("BENCH_DATABASE_URL must be a postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new BenchDatabaseError("BENCH_DATABASE_URL must be a postgres:// URL");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new BenchDatabaseError("BENCH_DATABASE_URL must point at a loopback host");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(databaseName) ||
    !databaseName.endsWith(BENCH_DATABASE_SUFFIX)
  ) {
    throw new BenchDatabaseError(
      `the benchmark database name must be lower-case and end in "${BENCH_DATABASE_SUFFIX}"`,
    );
  }
  return { url: raw, databaseName, password: decodeURIComponent(url.password) };
}

/** Runs `work` with one connected client and always closes it. */
export async function withBenchClient<T>(
  database: BenchDatabase,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
