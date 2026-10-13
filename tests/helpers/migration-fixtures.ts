import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MIGRATIONS_DIRECTORY } from "../../src/db/migrator.js";

/** A temporary migrations directory that a test may freely modify. */
export interface MigrationFixture {
  readonly directory: string;
  write(name: string, sql: string): Promise<void>;
  remove(): Promise<void>;
}

export async function createEmptyMigrationFixture(): Promise<MigrationFixture> {
  const directory = await mkdtemp(join(tmpdir(), "umqs-migrations-"));
  return {
    directory,
    write: (name, sql) => writeFile(join(directory, name), sql, "utf8"),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Copies the real migrations into a temporary directory. */
export async function copyProjectMigrations(): Promise<MigrationFixture> {
  const fixture = await createEmptyMigrationFixture();
  await cp(DEFAULT_MIGRATIONS_DIRECTORY, fixture.directory, { recursive: true });
  return fixture;
}
