import { afterEach, describe, expect, it } from "vitest";
import {
  checksumOf,
  compareMigrations,
  loadMigrations,
  MigrationError,
  type Migration,
} from "../../../src/db/migrator.js";
import {
  createEmptyMigrationFixture,
  type MigrationFixture,
} from "../../helpers/migration-fixtures.js";

let fixture: MigrationFixture | undefined;

async function emptyFixture(): Promise<MigrationFixture> {
  fixture = await createEmptyMigrationFixture();
  return fixture;
}

afterEach(async () => {
  await fixture?.remove();
  fixture = undefined;
});

function migration(name: string, sql = `SELECT '${name}';`): Migration {
  return { name, sql, checksum: checksumOf(sql) };
}

describe("loadMigrations", () => {
  it("loads the project migrations in order with SHA-256 checksums", async () => {
    const migrations = await loadMigrations();

    expect(migrations.map((entry) => entry.name)).toEqual([
      "0001_baseline_schema.sql",
      "0002_predefined_plans.sql",
    ]);
    for (const entry of migrations) {
      expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.checksum).toBe(checksumOf(entry.sql));
    }
  });

  it("orders files by name regardless of creation order and ignores non-SQL files", async () => {
    const directory = await emptyFixture();
    await directory.write("0010_later.sql", "SELECT 10;");
    await directory.write("0002_second.sql", "SELECT 2;");
    await directory.write("0001_first.sql", "SELECT 1;");
    await directory.write("README.md", "not a migration");

    const migrations = await loadMigrations(directory.directory);

    expect(migrations.map((entry) => entry.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
      "0010_later.sql",
    ]);
  });

  it("normalizes CRLF line endings before computing the checksum", async () => {
    const directory = await emptyFixture();
    await directory.write("0001_first.sql", "SELECT 1;\r\nSELECT 2;\r\n");

    const [loaded] = await loadMigrations(directory.directory);

    expect(loaded?.sql).toBe("SELECT 1;\nSELECT 2;\n");
    expect(loaded?.checksum).toBe(checksumOf("SELECT 1;\nSELECT 2;\n"));
  });

  it.each(["1_short.sql", "0001-dash.sql", "0001_Upper.sql", "0001_.sql", "abcd_name.sql"])(
    "rejects the invalid file name %s",
    async (name) => {
      const directory = await emptyFixture();
      await directory.write(name, "SELECT 1;");

      await expect(loadMigrations(directory.directory)).rejects.toThrow(MigrationError);
    },
  );

  it("rejects two migrations with the same number", async () => {
    const directory = await emptyFixture();
    await directory.write("0001_first.sql", "SELECT 1;");
    await directory.write("0001_other.sql", "SELECT 2;");

    await expect(loadMigrations(directory.directory)).rejects.toThrow(
      "More than one migration uses the number 0001",
    );
  });
});

describe("compareMigrations", () => {
  const first = migration("0001_first.sql");
  const second = migration("0002_second.sql");

  it("is current when every expected migration is applied with the same checksum", () => {
    expect(compareMigrations([first, second], [first, second])).toEqual({ state: "current" });
  });

  it("lists pending migrations in order", () => {
    expect(compareMigrations([], [first, second])).toEqual({
      state: "pending",
      pending: ["0001_first.sql", "0002_second.sql"],
    });
    expect(compareMigrations([first], [first, second])).toEqual({
      state: "pending",
      pending: ["0002_second.sql"],
    });
  });

  it("detects a migration modified after it was applied", () => {
    const status = compareMigrations(
      [{ name: first.name, checksum: checksumOf("other") }],
      [first],
    );

    expect(status).toEqual({
      state: "diverged",
      reason: "Migration 0001_first.sql was modified after it was applied (checksum mismatch)",
    });
  });

  it("detects an applied migration that this build does not ship", () => {
    expect(compareMigrations([first, second], [first]).state).toBe("diverged");
  });

  it("detects a migration inserted before an already-applied one", () => {
    const inserted = migration("0001_inserted.sql");

    expect(compareMigrations([second], [inserted, second])).toMatchObject({
      state: "diverged",
      reason: expect.stringContaining("does not match the expected migration") as unknown,
    });
  });
});
