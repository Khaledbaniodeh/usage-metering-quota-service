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

  // R25: "Store accounts, users, plans, assignments, usage, and request history in the database so
  // they survive a restart." Two real servers, one after the other, on the same database.
  it("keeps accounts, users, usage and history across a restart, and still replays requests", async () => {
    const send = async (
      running: RunningServer,
      method: string,
      path: string,
      credential?: string,
      body?: unknown,
    ) => {
      const headers: Record<string, string> = {};
      if (credential !== undefined) {
        headers["x-api-key"] = credential;
      }
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const response = await fetch(localUrl(running, path), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, text: await response.text() };
    };
    const migrationRows = () =>
      withTestClient(async (client) => {
        const result = await client.query<Record<string, unknown>>(
          "SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name",
        );
        return result.rows;
      });
    const decisionCount = (accountId: string) =>
      withTestClient(async (client) => {
        const result = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM consume_decisions WHERE account_id = $1",
          [accountId],
        );
        return result.rows[0]?.count;
      });

    const first = await startServer(testConfig(), createSilentLogger());
    server = first;
    const created = await send(first, "POST", "/v1/accounts", undefined, { name: "Restart" });
    expect(created.status).toBe(201);
    // The key stays in this variable only.
    const { apiKey, id: accountId } = JSON.parse(created.text) as { apiKey: string; id: string };
    const user = await send(first, "POST", "/v1/users", apiKey, { name: "Restart User" });
    expect(user.status).toBe(201);
    const userId = (JSON.parse(user.text) as { id: string }).id;
    const accepted = await send(first, "POST", "/v1/consume", apiKey, {
      userId,
      units: 10,
      requestId: "restart-accepted",
    });
    const rejected = await send(first, "POST", "/v1/consume", apiKey, {
      userId,
      units: 25,
      requestId: "restart-rejected",
    });
    expect([accepted.status, rejected.status]).toEqual([200, 200]);
    expect(JSON.parse(accepted.text)).toMatchObject({ accepted: true, user: { used: 10 } });
    expect(JSON.parse(rejected.text)).toMatchObject({
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
      user: { used: 10 },
    });
    /** Everything the API reports about the account, as exact response text. */
    const state = async (running: RunningServer) => ({
      account: await send(running, "GET", "/v1/account", apiKey),
      user: await send(running, "GET", `/v1/users/${userId}`, apiKey),
      accountUsage: await send(running, "GET", "/v1/usage", apiKey),
      userUsage: await send(running, "GET", `/v1/users/${userId}/usage`, apiKey),
      history: await send(running, "GET", "/v1/history", apiKey),
    });
    const before = await state(first);
    const migrationsBefore = await migrationRows();
    expect(JSON.parse(before.accountUsage.text)).toMatchObject({ used: 10 });
    expect(JSON.parse(before.history.text)).toMatchObject({
      decisions: [JSON.parse(rejected.text), JSON.parse(accepted.text)],
    });

    await first.stop();
    server = undefined;
    expect(first.pool.ended).toBe(true);

    const second = await startServer(testConfig(), createSilentLogger());
    server = second;

    // Nothing was migrated again, and every response is byte-for-byte the same with the old key.
    expect(await migrationRows()).toEqual(migrationsBefore);
    expect(await state(second)).toEqual(before);
    // The accepted request replays its original response and counts nothing.
    const replay = await send(second, "POST", "/v1/consume", apiKey, {
      userId,
      units: 10,
      requestId: "restart-accepted",
    });
    expect(replay).toEqual(accepted);
    expect(await send(second, "GET", "/v1/usage", apiKey)).toEqual(before.accountUsage);
    expect(await decisionCount(accountId)).toBe(2);
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
