import type pg from "pg";

/** Anything that hands out dedicated connections: the application pool. */
export type ConnectionSource = Pick<pg.Pool, "connect">;

/**
 * Runs `work` in one READ COMMITTED transaction on a dedicated pooled connection.
 *
 * The transaction commits when `work` resolves and rolls back when it throws (or when COMMIT
 * fails); the original error is rethrown. If ROLLBACK itself fails, the connection is in an
 * unknown state, so it is destroyed instead of being returned to the pool.
 */
export async function withTransaction<T>(
  source: ConnectionSource,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect();
  let brokenConnection: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      brokenConnection =
        rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed");
    }
    throw error;
  } finally {
    client.release(brokenConnection);
  }
}

/**
 * Limits how long the rest of the current transaction waits for any lock. SET LOCAL semantics:
 * the setting ends with the transaction, so pooled connections keep their defaults.
 */
export async function setLocalLockTimeout(client: pg.ClientBase, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("The lock timeout must be a positive integer number of milliseconds");
  }
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${String(timeoutMs)}ms`]);
}
