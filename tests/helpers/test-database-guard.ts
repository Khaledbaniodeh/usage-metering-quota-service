/**
 * Safety guard shared by every helper that creates, resets or drops a database. Destructive test
 * operations are only ever allowed on databases whose name ends in "_test".
 */

const TEST_DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]*_test$/;

export function assertTestDatabaseName(name: string): void {
  if (!TEST_DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to use database "${name}" for tests: the name must be lowercase and end in _test`,
    );
  }
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
