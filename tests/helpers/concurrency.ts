import pg from "pg";
import { APPLICATION_NAME } from "../../src/db/pool.js";
import { typeParsers } from "../../src/db/type-parsers.js";
import { testDatabaseUrl } from "./test-database.js";

/**
 * Deterministic synchronization for concurrency tests. Nothing here sleeps for a guessed amount
 * of time: tests hold real PostgreSQL row locks, wait until PostgreSQL itself reports the
 * expected number of application backends blocked on a lock, and only then release. Every wait
 * has a deadline, so a regression fails the test instead of hanging CI.
 */

const DEFAULT_DEADLINE_MS = 10_000;
const POLL_INTERVAL_MS = 5;

/** A lock held by a separate test connection inside an open transaction. */
export interface HeldLock {
  /** Ends the holder's transaction (ROLLBACK), releasing its locks. */
  readonly release: () => Promise<void>;
}

/**
 * Creates the account counter row for the month if needed (committed), then holds its row lock
 * from a separate connection, exactly as a consume transaction would. A consume for this account
 * and month then takes its plan snapshot and blocks before it can lock the counter.
 */
export async function holdAccountCounterLock(accountId: string, month: string): Promise<HeldLock> {
  const client = new pg.Client({
    connectionString: testDatabaseUrl(),
    types: typeParsers,
    application_name: "quota-test-lock-holder",
  });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, $2)
       ON CONFLICT (account_id, month) DO NOTHING`,
      [accountId, month],
    );
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT used FROM account_monthly_usage WHERE account_id = $1 AND month = $2 FOR UPDATE",
      [accountId, month],
    );
    if (locked.rowCount !== 1) {
      throw new Error("The account counter row to lock does not exist");
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Inserts the account counter row for the month in an open, uncommitted transaction. Consumes
 * for this account and month block on that pending insert (inside INSERT ... ON CONFLICT) until
 * `release` rolls it back. The row then never existed, so the blocked consumes race to create
 * the counters from a cold start.
 */
export async function holdPendingAccountCounterInsert(
  accountId: string,
  month: string,
): Promise<HeldLock> {
  const client = new pg.Client({
    connectionString: testDatabaseUrl(),
    types: typeParsers,
    application_name: "quota-test-lock-holder",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO account_monthly_usage (account_id, month) VALUES ($1, $2)", [
      accountId,
      month,
    ]);
  } catch (error) {
    await client.end();
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

/** Application backends (the service's pool) currently waiting for a lock in the test database. */
export async function countApplicationLockWaiters(): Promise<number> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), types: typeParsers });
  await client.connect();
  try {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND wait_event_type = 'Lock'`,
      [APPLICATION_NAME],
    );
    return result.rows[0]?.count ?? 0;
  } finally {
    await client.end();
  }
}

/**
 * Resolves once PostgreSQL reports exactly `expected` application backends waiting for a lock.
 * Polls the database (the observed condition, not elapsed time, is what synchronizes the test)
 * and fails after the deadline.
 */
export async function waitForLockWaiters(
  expected: number,
  deadlineMs = DEFAULT_DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let observed = -1;
  while (Date.now() < deadline) {
    observed = await countApplicationLockWaiters();
    if (observed === expected) {
      return;
    }
    if (observed > expected) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Expected ${String(expected)} application backends waiting for a lock, observed ${String(observed)}`,
  );
}

/** Rejects when `promise` has not settled within `deadlineMs` (e.g. a request that is blocked). */
export async function within<T>(
  promise: Promise<T>,
  deadlineMs: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} did not finish within ${String(deadlineMs)} ms`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A promise with its resolve function exposed, used as a one-shot barrier. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  if (resolve === undefined) {
    throw new Error("Promise executor did not run synchronously");
  }
  return { promise, resolve };
}

type QueryFunction = (this: pg.Client, ...args: unknown[]) => unknown;

/**
 * Test-only interception of SQL sent by any pg.Client (the service's pooled connections and test
 * connections alike). `handler` sees each statement's text and either returns undefined to run it
 * normally, or returns a promise that replaces the query (to delay or fail it). Restore with the
 * returned function.
 */
export function interceptQueries(
  handler: (text: string, run: () => Promise<unknown>) => Promise<unknown> | undefined,
): () => void {
  const prototype = pg.Client.prototype as unknown as { query: QueryFunction };
  const original = prototype.query;
  prototype.query = function intercepted(this: pg.Client, ...args: unknown[]): unknown {
    const [first] = args;
    const text =
      typeof first === "string"
        ? first
        : typeof first === "object" && first !== null && "text" in first
          ? String(first.text)
          : "";
    const run = () => original.apply(this, args) as Promise<unknown>;
    const replacement = handler(text, run);
    return replacement ?? original.apply(this, args);
  };
  return () => {
    prototype.query = original;
  };
}
