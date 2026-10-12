import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../../src/app/server.js";
import { MigrationError } from "../../../src/db/migrator.js";
import { createSilentLogger } from "../../helpers/logger.js";
import { copyProjectMigrations, type MigrationFixture } from "../../helpers/migration-fixtures.js";
import {
  migrateTestDatabase,
  resetTestDatabase,
  testConfig,
  UNREACHABLE_DATABASE_URL,
  withTestClient,
} from "../../helpers/test-database.js";

let server: RunningServer | undefined;
let fixture: MigrationFixture | undefined;

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(async () => {
  await server?.stop();
  await fixture?.remove();
  server = undefined;
  fixture = undefined;
});

function localUrl(running: RunningServer, path: string): string {
  const address = running.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the server to listen on a TCP port");
  }
  return `http://127.0.0.1:${String(address.port)}${path}`;
}

describe("startServer", () => {
  it("migrates the database before serving traffic and answers over real HTTP", async () => {
    server = await startServer(testConfig(), createSilentLogger());

    const appliedCount = await withTestClient(async (client) => {
      const result = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM schema_migrations",
      );
      return result.rows[0]?.count;
    });
    const live = await fetch(localUrl(server, "/health/live"));
    const ready = await fetch(localUrl(server, "/health/ready"));

    expect(appliedCount).toBe(2);
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  it("stops the HTTP server and closes the pool without leaving handles open", async () => {
    const running = await startServer(testConfig(), createSilentLogger());
    await fetch(localUrl(running, "/health/ready"));

    await running.stop();

    expect(running.app.server.listening).toBe(false);
    expect(running.pool.ended).toBe(true);
    expect(running.pool.totalCount).toBe(0);
    await expect(running.stop()).resolves.toBeUndefined();
  });

  it("starts against an already-migrated database without reapplying migrations", async () => {
    await migrateTestDatabase();

    server = await startServer(testConfig(), createSilentLogger());

    const response = await fetch(localUrl(server, "/health/ready"));
    expect(response.status).toBe(200);
  });

  it("treats a modified applied migration as a fatal startup error", async () => {
    fixture = await copyProjectMigrations();
    await migrateTestDatabase(fixture.directory);
    await appendFile(join(fixture.directory, "0002_predefined_plans.sql"), "\n-- edited\n");

    const start = startServer(testConfig(), createSilentLogger(), {
      migrationsDirectory: fixture.directory,
    });

    await expect(start).rejects.toThrow(MigrationError);
  });

  it("treats an unreachable database as a fatal startup error", async () => {
    const config = testConfig(UNREACHABLE_DATABASE_URL);

    await expect(
      startServer(
        { ...config, database: { ...config.database, connectionTimeoutMs: 1_000 } },
        createSilentLogger(),
      ),
    ).rejects.toThrow();
  });

  it("fails startup when the HTTP port is already in use", async () => {
    server = await startServer(testConfig(), createSilentLogger());
    const address = server.app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }

    await expect(
      startServer({ ...testConfig(), port: address.port }, createSilentLogger()),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
