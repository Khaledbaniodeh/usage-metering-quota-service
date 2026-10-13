/** SQLSTATE 23505: a UNIQUE or PRIMARY KEY constraint was violated. */
const UNIQUE_VIOLATION = "23505";

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
