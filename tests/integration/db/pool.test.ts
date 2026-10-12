import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "../../../src/db/pool.js";
import { createSilentLogger } from "../../helpers/logger.js";
import { testConfig } from "../../helpers/test-database.js";

let pool: pg.Pool | undefined;

function testPool(): pg.Pool {
  pool = createPool(testConfig().database, createSilentLogger());
  return pool;
}

afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

describe("createPool", () => {
  it("returns BIGINT values as safe numbers and DATE values as calendar strings", async () => {
    const { rows } = await testPool().query<{ counter: number; month: string }>(
      "SELECT 9007199254740991::bigint AS counter, DATE '2026-10-01' AS month",
    );

    expect(rows).toEqual([{ counter: Number.MAX_SAFE_INTEGER, month: "2026-10-01" }]);
  });

  it("fails loudly instead of losing BIGINT precision", async () => {
    await expect(testPool().query("SELECT 9007199254740992::bigint AS too_big")).rejects.toThrow(
      RangeError,
    );
  });

  it("applies the configured statement timeout to every connection", async () => {
    const { rows } = await testPool().query<{ statement_timeout: string }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout",
    );

    expect(rows[0]?.statement_timeout).toBe("5s");
  });

  it("closes cleanly, leaving no connections behind", async () => {
    const activePool = testPool();
    await activePool.query("SELECT 1");

    await activePool.end();
    pool = undefined;

    expect(activePool.ended).toBe(true);
    expect(activePool.totalCount).toBe(0);
  });
});
