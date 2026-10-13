/** SQLSTATE 23505: a UNIQUE or PRIMARY KEY constraint was violated. */
const UNIQUE_VIOLATION = "23505";

/** SQLSTATE 55P03: a lock could not be acquired within lock_timeout (or NOWAIT). */
const LOCK_NOT_AVAILABLE = "55P03";

/** True when `error` is PostgreSQL's unique violation of exactly the named constraint. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

/**
 * True when `error` is PostgreSQL's lock_not_available: the statement gave up waiting for a row
 * lock. Statement timeouts, deadlocks and every other failure are deliberately excluded.
 */
export function isLockNotAvailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === LOCK_NOT_AVAILABLE
  );
}
