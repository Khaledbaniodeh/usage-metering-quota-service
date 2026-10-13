import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  holdAccountCounterLock,
  interceptQueries,
  waitForLockWaiters,
  within,
  type HeldLock,
} from "../../../helpers/concurrency.js";
import {
  assignAccountPlan,
  assignUserPlan,
  countCounterRows,
  countDecisions,
  createTestPlan,
  createTestUser,
  PREDEFINED_PLAN_IDS,
  readCounters,
  type TestUser,
} from "../../../helpers/consumption.js";
import { checkQuotaInvariants, noViolations } from "../../../helpers/quota-invariants.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";

/**
 * Quota correctness under concurrency, plan-snapshot consistency, bounded lock waiting and
 * rollback. Contention is created deterministically: a test connection holds the account
 * counter lock until PostgreSQL reports the expected number of blocked application backends.
 */

const OCTOBER = "2026-10-01";
const POOL_MAX = 12;
const now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let held: HeldLock[] = [];
let restoreQueries: (() => void) | undefined;

interface Decision {
  accepted: boolean;
  blockingRule: string | null;
  blockingLevel: string | null;
  account: {
    planId: string;
    planName: string;
    monthlyAllowance: number;
    maxUnitsPerRequest: number;
    used: number;
  };
  user: {
    planId: string;
    planName: string;
    monthlyAllowance: number;
    maxUnitsPerRequest: number;
    used: number;
  };
}

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({
    clock: () => now,
    database: { poolMax: POOL_MAX, connectionTimeoutMs: 15_000 },
  });
});

afterEach(async () => {
  restoreQueries?.();
  restoreQueries = undefined;
  await Promise.all(held.map((lock) => lock.release()));
  held = [];
});

afterAll(async () => {
  expect(await checkQuotaInvariants()).toEqual(noViolations());
  await integration.close();
});

let requestSequence = 0;
function consume(account: TestAccount, userId: string, units: number, app = integration.app) {
  requestSequence += 1;
  return authenticatedRequest(app, account, {
    method: "POST",
    url: "/v1/consume",
    payload: { userId, units, requestId: `c-${String(requestSequence)}` },
  });
}

async function freshTenant(name: string): Promise<{ account: TestAccount; user: TestUser }> {
  const account = await createTestAccount(integration.app, name);
  const user = await createTestUser(integration.app, account, `${name} User`);
  return { account, user };
}

/**
 * Sends every request while the listed accounts' counters are locked, waits until PostgreSQL
 * reports `blocked` application backends waiting, then releases, so all requests contend at once.
 */
async function contended(
  accounts: readonly TestAccount[],
  requests: readonly (() => ReturnType<typeof consume>)[],
  blocked: number,
) {
  for (const account of accounts) {
    held.push(await holdAccountCounterLock(account.id, OCTOBER));
  }
  const responses = Promise.all(requests.map((send) => send()));
  await waitForLockWaiters(blocked);
  await Promise.all(held.map((lock) => lock.release()));
  return within(responses, 20_000, "the contended requests");
}

describe("plan changes while a consume is in flight", () => {
  it("are not blocked by it, and the consume uses one complete snapshot", async () => {
    const { account, user } = await freshTenant("Snapshot Race");
    const seat = await createTestPlan(integration.app, account, {
      name: "Old Seat",
      scope: "USER",
      monthlyAllowance: 500,
      maxUnitsPerRequest: 50,
    });
    await assignUserPlan(integration.app, account, user.id, seat);
    held.push(await holdAccountCounterLock(account.id, OCTOBER));

    // The consume reads its plan snapshot, then blocks before it can lock the account counter.
    const inFlight = consume(account, user.id, 40);
    await waitForLockWaiters(1);

    // Plan edits and switches complete while the consume is still waiting.
    const patch = await within(
      authenticatedRequest(integration.app, account, {
        method: "PATCH",
        url: `/v1/plans/${seat}`,
        payload: { name: "New Seat", monthlyAllowance: 30, maxUnitsPerRequest: 10 },
      }),
      2_000,
      "the plan update",
    );
    const accountSwitch = await within(
      authenticatedRequest(integration.app, account, {
        method: "PUT",
        url: "/v1/account/plan",
        payload: { planId: PREDEFINED_PLAN_IDS.pro },
      }),
      2_000,
      "the account plan switch",
    );
    expect(patch.statusCode).toBe(200);
    expect(accountSwitch.statusCode).toBe(200);
    await waitForLockWaiters(1);

    await held[0]?.release();
    const decision = (await within(inFlight, 5_000, "the consume")).json<Decision>();

    // Entirely the state before the changes: old names with old limits, old assignments.
    expect(decision).toMatchObject({
      accepted: true,
      account: {
        planId: PREDEFINED_PLAN_IDS.starter,
        planName: "Starter",
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
      },
      user: { planId: seat, planName: "Old Seat", monthlyAllowance: 500, maxUnitsPerRequest: 50 },
    });

    // The next request sees entirely the new state.
    const next = (await consume(account, user.id, 40)).json<Decision>();
    expect(next).toMatchObject({
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
      account: { planName: "Pro", monthlyAllowance: 100_000, maxUnitsPerRequest: 1_000 },
      user: { planName: "New Seat", monthlyAllowance: 30, maxUnitsPerRequest: 10, used: 40 },
    });
  });

  it("is not blocked by a user plan switch either", async () => {
    const { account, user } = await freshTenant("Switch Race");
    held.push(await holdAccountCounterLock(account.id, OCTOBER));
    const inFlight = consume(account, user.id, 20);
    await waitForLockWaiters(1);

    const userSwitch = await within(
      authenticatedRequest(integration.app, account, {
        method: "PUT",
        url: `/v1/users/${user.id}/plan`,
        payload: { planId: PREDEFINED_PLAN_IDS.premium },
      }),
      2_000,
      "the user plan switch",
    );
    expect(userSwitch.statusCode).toBe(200);

    await held[0]?.release();
    const decision = (await within(inFlight, 5_000, "the consume")).json<Decision>();
    expect(decision.user).toMatchObject({ planName: "Basic", maxUnitsPerRequest: 20 });
  });
});

describe("allowances under concurrent consumption", () => {
  it("never lets one user exceed the user allowance", async () => {
    const { account, user } = await freshTenant("Hot User");

    const responses = await contended(
      [account],
      Array.from({ length: 60 }, () => () => consume(account, user.id, 20)),
      POOL_MAX,
    );

    const decisions = responses.map((response) => {
      expect(response.statusCode, response.body).toBe(200);
      return response.json<Decision>();
    });
    expect(decisions.filter((decision) => decision.accepted)).toHaveLength(50);
    for (const rejected of decisions.filter((decision) => !decision.accepted)) {
      expect(rejected).toMatchObject({ blockingRule: "MONTHLY_ALLOWANCE", blockingLevel: "USER" });
    }
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({
      account: 1_000,
      user: 1_000,
    });
  });

  it("never lets the users of one account exceed the shared allowance, without deadlocks", async () => {
    const account = await createTestAccount(integration.app, "Shared Pool");
    const shared = await createTestPlan(integration.app, account, {
      name: "Shared Hundred",
      scope: "ACCOUNT",
      monthlyAllowance: 100,
      maxUnitsPerRequest: 100,
    });
    await assignAccountPlan(integration.app, account, shared);
    const users: TestUser[] = [];
    for (let index = 0; index < 5; index += 1) {
      const user = await createTestUser(integration.app, account, `Member ${String(index)}`);
      await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);
      users.push(user);
    }

    const responses = await contended(
      [account],
      Array.from(
        { length: 40 },
        (_, index) => () => consume(account, users[index % users.length]?.id ?? "", 5),
      ),
      POOL_MAX,
    );

    // A deadlock would surface as a 500; every request must get a decision.
    expect(responses.map((response) => response.statusCode)).toEqual(Array(40).fill(200));
    const decisions = responses.map((response) => response.json<Decision>());
    expect(decisions.filter((decision) => decision.accepted)).toHaveLength(20);
    for (const rejected of decisions.filter((decision) => !decision.accepted)) {
      expect(rejected).toMatchObject({
        blockingRule: "MONTHLY_ALLOWANCE",
        blockingLevel: "ACCOUNT",
      });
    }
    let userTotal = 0;
    for (const user of users) {
      const counters = await readCounters(account.id, user.id, OCTOBER);
      expect(counters.account).toBe(100);
      userTotal += counters.user ?? 0;
    }
    expect(userTotal).toBe(100);
  });

  it("keeps different accounts independent of each other", async () => {
    const tenants = [await freshTenant("Independent A"), await freshTenant("Independent B")];
    for (const { account, user } of tenants) {
      const plan = await createTestPlan(integration.app, account, {
        name: "Fifty",
        scope: "ACCOUNT",
        monthlyAllowance: 50,
        maxUnitsPerRequest: 50,
      });
      await assignAccountPlan(integration.app, account, plan);
      await assignUserPlan(integration.app, account, user.id, PREDEFINED_PLAN_IDS.premium);
    }

    const responses = await contended(
      tenants.map(({ account }) => account),
      Array.from({ length: 30 }, (_, index) => {
        const tenant = tenants[index % 2];
        if (tenant === undefined) {
          throw new Error("missing tenant");
        }
        return () => consume(tenant.account, tenant.user.id, 5);
      }),
      POOL_MAX,
    );

    expect(responses.map((response) => response.statusCode)).toEqual(Array(30).fill(200));
    for (const { account, user } of tenants) {
      expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 50, user: 50 });
      expect(await countDecisions(account.id)).toBe(15);
    }
  });
});

describe("bounded lock waiting", () => {
  let impatient: IntegrationApp;

  beforeAll(async () => {
    impatient = await createIntegrationApp({ clock: () => now, database: { lockTimeoutMs: 150 } });
  });

  afterAll(async () => {
    await impatient.close();
  });

  it("answers 503 BUSY_RETRY with Retry-After and records nothing; the same request succeeds later", async () => {
    const { account, user } = await freshTenant("Busy");
    held.push(await holdAccountCounterLock(account.id, OCTOBER));
    const payload = { userId: user.id, units: 3, requestId: "busy-1" };

    const busy = await within(
      authenticatedRequest(impatient.app, account, {
        method: "POST",
        url: "/v1/consume",
        payload,
      }),
      5_000,
      "the timed-out consume",
    );

    expect(busy.statusCode).toBe(503);
    expect(busy.headers["retry-after"]).toBe("1");
    expect(busy.json()).toEqual({
      error: { code: "BUSY_RETRY", message: "The service is busy; retry the same request shortly" },
    });
    expect(await countDecisions(account.id)).toBe(0);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({
      account: 0,
      user: undefined,
    });

    await held[0]?.release();
    const retry = await authenticatedRequest(impatient.app, account, {
      method: "POST",
      url: "/v1/consume",
      payload,
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ accepted: true, units: 3 });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 3, user: 3 });
    expect(await countDecisions(account.id, "busy-1")).toBe(1);
  });
});

describe("rollback", () => {
  it.each([
    [
      "the decision insert",
      (text: string) => text.trimStart().startsWith("INSERT INTO consume_decisions"),
    ],
    ["COMMIT", (text: string) => text === "COMMIT"],
  ])(
    "undoes both counter increments when %s fails, and the request can be retried",
    async (_label, failsAt) => {
      const { account, user } = await freshTenant("Rollback");
      await consume(account, user.id, 2);
      const before = await readCounters(account.id, user.id, OCTOBER);
      const statements: string[] = [];
      let failed = false;
      restoreQueries = interceptQueries((text) => {
        statements.push(text.trimStart().split(/\s+/).slice(0, 3).join(" "));
        if (failed || !failsAt(text)) {
          return undefined;
        }
        failed = true;
        return Promise.reject(new Error("injected failure"));
      });
      const payload = { userId: user.id, units: 5, requestId: "fragile" };

      const failure = await authenticatedRequest(integration.app, account, {
        method: "POST",
        url: "/v1/consume",
        payload,
      });
      restoreQueries();
      restoreQueries = undefined;

      // Both counters had been incremented inside the transaction before the failure.
      expect(statements).toContain("UPDATE account_monthly_usage SET");
      expect(statements).toContain("UPDATE user_monthly_usage SET");
      expect(failure.statusCode).toBe(500);
      expect(failure.json()).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
      expect(await readCounters(account.id, user.id, OCTOBER)).toEqual(before);
      expect(await countDecisions(account.id, "fragile")).toBe(0);

      const retry = await authenticatedRequest(integration.app, account, {
        method: "POST",
        url: "/v1/consume",
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({
        account: (before.account ?? 0) + 5,
        user: (before.user ?? 0) + 5,
      });
    },
  );

  it("writes nothing for a foreign user, even under contention", async () => {
    const caller = await freshTenant("Caller");
    const owner = await freshTenant("Owner");

    const responses = await Promise.all(
      [1, 2, 3].map(() => consume(caller.account, owner.user.id, 1)),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(await countCounterRows(caller.account.id)).toBe(0);
    expect(await countCounterRows(owner.account.id)).toBe(0);
  });
});
