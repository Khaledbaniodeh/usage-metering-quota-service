import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  deferred,
  holdAccountCounterLock,
  interceptQueries,
  waitForLockWaiters,
  within,
  type HeldLock,
} from "../../../helpers/concurrency.js";
import {
  countCounterRows,
  countDecisions,
  createTestUser,
  readCounters,
  type TestUser,
} from "../../../helpers/consumption.js";
import {
  checkQuotaInvariants,
  decisionHistoryRejectsChanges,
  noViolations,
} from "../../../helpers/quota-invariants.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";

/**
 * Idempotency and tenant isolation of POST /v1/consume, including races. Races are made
 * deterministic with real PostgreSQL locks: a test connection holds the account counter lock,
 * the racing requests are sent, the test waits until PostgreSQL reports all of them blocked, and
 * only then releases the lock.
 */

const OCTOBER = "2026-10-01";
const NOVEMBER = "2026-11-01";
let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let held: HeldLock | undefined;
let restoreQueries: (() => void) | undefined;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now, database: { poolMax: 10 } });
});

afterEach(async () => {
  restoreQueries?.();
  restoreQueries = undefined;
  await held?.release();
  held = undefined;
  now = new Date("2026-10-13T12:00:00.000Z");
});

afterAll(async () => {
  expect(await checkQuotaInvariants()).toEqual(noViolations());
  await integration.close();
});

function consume(account: TestAccount, payload: object) {
  return authenticatedRequest(integration.app, account, {
    method: "POST",
    url: "/v1/consume",
    payload,
  });
}

async function freshTenant(name: string): Promise<{ account: TestAccount; user: TestUser }> {
  const account = await createTestAccount(integration.app, name);
  const user = await createTestUser(integration.app, account, `${name} User`);
  return { account, user };
}

describe("tenant isolation of request IDs and users", () => {
  it("never replays another account's decision: the same payload from another account is 404", async () => {
    const a = await freshTenant("Isolation A");
    const b = await freshTenant("Isolation B");
    const original = await consume(a.account, { userId: a.user.id, units: 4, requestId: "secret" });
    expect(original.statusCode).toBe(200);

    const stolen = await consume(b.account, { userId: a.user.id, units: 4, requestId: "secret" });

    expect(stolen.statusCode).toBe(404);
    expect(stolen.json()).toEqual({ error: { code: "NOT_FOUND", message: "User not found" } });
    expect(stolen.body).not.toContain(a.user.id);
    expect(await countDecisions(b.account.id)).toBe(0);
    expect(await countCounterRows(b.account.id)).toBe(0);
    expect(await readCounters(a.account.id, a.user.id, OCTOBER)).toEqual({ account: 4, user: 4 });
  });

  it("keeps request IDs separate: one account's key does not block or conflict with another's", async () => {
    const a = await freshTenant("Keys A");
    const b = await freshTenant("Keys B");
    await consume(a.account, { userId: a.user.id, units: 9, requestId: "k" });

    const bFirst = await consume(b.account, { userId: b.user.id, units: 1, requestId: "k" });
    const aRetry = await consume(a.account, { userId: a.user.id, units: 9, requestId: "k" });

    expect(bFirst.json()).toMatchObject({ accepted: true, units: 1, userId: b.user.id });
    expect(aRetry.json()).toMatchObject({ accepted: true, units: 9, userId: a.user.id });
    expect(await readCounters(b.account.id, b.user.id, OCTOBER)).toEqual({ account: 1, user: 1 });
  });
});

describe("concurrent duplicates (deterministic)", () => {
  it("lets identical concurrent requests create one decision and one increment", async () => {
    const { account, user } = await freshTenant("Identical Race");
    held = await holdAccountCounterLock(account.id, OCTOBER);
    const payload = { userId: user.id, units: 7, requestId: "dup" };

    const responses = Promise.all([1, 2, 3, 4].map(() => consume(account, payload)));
    await waitForLockWaiters(4);
    await held.release();
    const settled = await within(responses, 10_000, "the racing requests");

    expect(settled.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    expect(new Set(settled.map((response) => response.body)).size).toBe(1);
    expect(await countDecisions(account.id, "dup")).toBe(1);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 7, user: 7 });
  });

  it("lets exactly one of several conflicting duplicates win; every other one conflicts", async () => {
    const { account, user } = await freshTenant("Conflicting Race");
    const second = await createTestUser(integration.app, account, "Second");
    held = await holdAccountCounterLock(account.id, OCTOBER);
    const payloads = [
      { userId: user.id, units: 1, requestId: "contested" },
      { userId: user.id, units: 2, requestId: "contested" },
      { userId: second.id, units: 3, requestId: "contested" },
    ];

    const responses = Promise.all(payloads.map((payload) => consume(account, payload)));
    await waitForLockWaiters(3);
    await held.release();
    const settled = await within(responses, 10_000, "the racing requests");

    const winners = settled.filter((response) => response.statusCode === 200);
    const losers = settled.filter((response) => response.statusCode !== 200);
    expect(winners).toHaveLength(1);
    expect(losers.map((response) => response.statusCode)).toEqual([409, 409]);
    for (const loser of losers) {
      expect(loser.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_CONFLICT");
    }
    const winner = winners[0]?.json<{ userId: string; units: number }>();
    expect(await countDecisions(account.id)).toBe(1);
    const firstCounters = await readCounters(account.id, user.id, OCTOBER);
    const secondCounters = await readCounters(account.id, second.id, OCTOBER);
    expect(firstCounters.account).toBe(winner?.units);
    expect(firstCounters.user).toBe(winner?.userId === user.id ? winner.units : undefined);
    expect(secondCounters.user).toBe(winner?.userId === second.id ? winner.units : undefined);
  });
});

describe("idempotency re-check inside the transaction", () => {
  /**
   * Both requests pass the fast path while no decision exists, then block on the account counter
   * lock. The first one to get the lock decides and commits. The second gets the lock, finds the
   * committed decision with the in-transaction lookup, and must replay it: no evaluation result
   * persisted, no counter update and no second decision insert even attempted. The statements the
   * service sends are counted to prove which path ran, since the unique-violation backstop would
   * otherwise mask a missing re-check.
   */
  it("replays a decision committed by a concurrent request without counting or inserting again", async () => {
    const { account, user } = await freshTenant("Recheck");
    held = await holdAccountCounterLock(account.id, OCTOBER);
    const sent = { lookups: 0, counterUpdates: 0, decisionInserts: 0 };
    restoreQueries = interceptQueries((text) => {
      const statement = text.trimStart();
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM consume_decisions") &&
        statement.includes("WHERE account_id = $1 AND request_id = $2")
      ) {
        sent.lookups += 1;
      } else if (
        statement.startsWith("UPDATE account_monthly_usage SET used = used +") ||
        statement.startsWith("UPDATE user_monthly_usage SET used = used +")
      ) {
        sent.counterUpdates += 1;
      } else if (statement.startsWith("INSERT INTO consume_decisions")) {
        sent.decisionInserts += 1;
      }
      return undefined;
    });
    const payload = { userId: user.id, units: 6, requestId: "recheck" };

    const responses = Promise.all([consume(account, payload), consume(account, payload)]);
    await waitForLockWaiters(2);
    // Both fast-path lookups ran (and found nothing) before either request could decide.
    expect(sent).toEqual({ lookups: 2, counterUpdates: 0, decisionInserts: 0 });
    await held.release();
    const [first, second] = await within(responses, 10_000, "the two requests");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    // Two fast-path lookups and two in-transaction lookups; one decision's worth of writes.
    expect(sent).toEqual({ lookups: 4, counterUpdates: 2, decisionInserts: 1 });
    expect(await countDecisions(account.id)).toBe(1);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 6, user: 6 });
  });
});

describe("unique-violation backstop across a UTC month boundary", () => {
  /**
   * R1 (31 October) is paused just before COMMIT, holding the October counter locks and its
   * uncommitted decision. R2 (1 November) locks the November counters, finds no committed
   * decision, increments and inserts, and blocks on R1's unique key. Releasing R1 makes R2's
   * insert fail with the unique violation: R2 must roll back everything and answer from R1.
   */
  async function raceAcrossMonths(secondUnits: number) {
    const { account, user } = await freshTenant(`Backstop ${String(secondUnits)}`);
    const atCommit = deferred();
    const releaseCommit = deferred();
    let paused = false;
    restoreQueries = interceptQueries((text, run) => {
      if (text !== "COMMIT" || paused) {
        return undefined;
      }
      paused = true;
      atCommit.resolve();
      return releaseCommit.promise.then(run);
    });

    now = new Date("2026-10-31T23:59:59.999Z");
    const first = consume(account, { userId: user.id, units: 5, requestId: "edge" });
    await within(atCommit.promise, 10_000, "the October request reaching COMMIT");

    now = new Date("2026-11-01T00:00:00.000Z");
    const second = consume(account, { userId: user.id, units: secondUnits, requestId: "edge" });
    await waitForLockWaiters(1);
    releaseCommit.resolve();

    const [firstResponse, secondResponse] = await within(
      Promise.all([first, second]),
      10_000,
      "both requests",
    );
    return { account, user, firstResponse, secondResponse };
  }

  it("replays the winner for an identical duplicate and rolls back the loser's counters", async () => {
    const { account, user, firstResponse, secondResponse } = await raceAcrossMonths(5);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.body).toBe(firstResponse.body);
    expect(firstResponse.json()).toMatchObject({ month: "2026-10", accepted: true });
    expect(await countDecisions(account.id)).toBe(1);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 5, user: 5 });
    expect(await readCounters(account.id, user.id, NOVEMBER)).toEqual({
      account: undefined,
      user: undefined,
    });
  });

  it("answers a conflicting duplicate with 409 and rolls back the loser's counters", async () => {
    const { account, user, firstResponse, secondResponse } = await raceAcrossMonths(6);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json<{ error: { code: string } }>().error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await countDecisions(account.id)).toBe(1);
    expect(await readCounters(account.id, user.id, NOVEMBER)).toEqual({
      account: undefined,
      user: undefined,
    });
  });
});

describe("decision history", () => {
  it("cannot be changed or deleted", async () => {
    const { account, user } = await freshTenant("Immutable");
    await consume(account, { userId: user.id, units: 1, requestId: "keep" });

    // 23001 restrict_violation, raised by the append-only trigger.
    expect(await decisionHistoryRejectsChanges()).toEqual({ update: "23001", delete: "23001" });
    expect(await countDecisions(account.id, "keep")).toBe(1);
  });
});
