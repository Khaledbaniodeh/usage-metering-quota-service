import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QUOTA_LEVELS,
  QUOTA_RULES,
  type ConsumeDecision,
} from "../../../../src/modules/consumption/consume.domain.js";
import {
  createConsumptionService,
  type ConsumptionService,
} from "../../../../src/modules/consumption/consume.service.js";
import { AppError } from "../../../../src/shared/http-errors.js";
import {
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../../helpers/account-harness.js";
import {
  countCounterRows,
  countDecisions,
  createTestUser,
  PREDEFINED_PLAN_IDS,
  readCounters,
  type TestUser,
} from "../../../helpers/consumption.js";
import { createIntegrationApp, type IntegrationApp } from "../../../helpers/test-app.js";
import { withTestClient } from "../../../helpers/test-database.js";

/**
 * The transactional consume workflow on real PostgreSQL, called directly (the HTTP contract is
 * covered by the API tests). Fixtures are created through the real API.
 */

const OCTOBER = "2026-10-01";
let now = new Date("2026-10-13T12:00:00.000Z");
let clockReads = 0;
let integration: IntegrationApp;
let service: ConsumptionService;
let account: TestAccount;
let other: TestAccount;
let user: TestUser;
let otherUser: TestUser;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
  service = createConsumptionService({
    db: integration.pool,
    clock: () => {
      clockReads += 1;
      return now;
    },
    lockTimeoutMs: 2_000,
  });
  account = await createTestAccount(integration.app, "Service A");
  other = await createTestAccount(integration.app, "Service B");
  user = await createTestUser(integration.app, account, "Service User");
  otherUser = await createTestUser(integration.app, other, "Other User");
});

afterAll(async () => {
  await integration.close();
});

async function expectAppError(promise: Promise<unknown>, code: string, message?: string) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  if (message !== undefined) {
    expect((error as AppError).message).toBe(message);
  }
}

describe("consume workflow", () => {
  it("accepts a request, counts it at both levels and stores the full snapshot", async () => {
    const decision = await service.consume(account.id, {
      userId: user.id,
      units: 10,
      requestId: "svc-accept",
    });

    expect(decision).toEqual<ConsumeDecision>({
      requestId: "svc-accept",
      userId: user.id,
      units: 10,
      accepted: true,
      blockingRule: null,
      blockingLevel: null,
      month: OCTOBER,
      processedAt: now,
      account: {
        planId: PREDEFINED_PLAN_IDS.starter,
        planName: "Starter",
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
        usedBefore: 0,
      },
      user: {
        planId: PREDEFINED_PLAN_IDS.basic,
        planName: "Basic",
        monthlyAllowance: 1_000,
        maxUnitsPerRequest: 20,
        usedBefore: 0,
      },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 10, user: 10 });
  });

  it("records a rejection without changing either counter", async () => {
    const decision = await service.consume(account.id, {
      userId: user.id,
      units: 25,
      requestId: "svc-reject",
    });

    expect(decision).toMatchObject({
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
      account: { usedBefore: 10 },
      user: { usedBefore: 10 },
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 10, user: 10 });
    expect(await countDecisions(account.id, "svc-reject")).toBe(1);
  });

  it("replays a decided request from its record without reading the clock or counting again", async () => {
    clockReads = 0;

    const replay = await service.consume(account.id, {
      userId: user.id,
      units: 10,
      requestId: "svc-accept",
    });

    expect(replay.processedAt.toISOString()).toBe("2026-10-13T12:00:00.000Z");
    expect(clockReads).toBe(0);
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 10, user: 10 });
    expect(await countDecisions(account.id, "svc-accept")).toBe(1);
  });

  it("reads the clock exactly once for a new request", async () => {
    clockReads = 0;

    await service.consume(account.id, { userId: user.id, units: 1, requestId: "svc-clock" });

    expect(clockReads).toBe(1);
  });

  it("treats the user ID case-insensitively and stores it in lower case", async () => {
    const decision = await service.consume(account.id, {
      userId: user.id.toUpperCase(),
      units: 1,
      requestId: "svc-upper",
    });
    const replay = await service.consume(account.id, {
      userId: user.id,
      units: 1,
      requestId: "svc-upper",
    });

    expect(decision.userId).toBe(user.id);
    expect(replay).toEqual(decision);
  });

  it.each([
    ["another user", () => ({ userId: otherUser.id, units: 10 })],
    ["other units", () => ({ userId: user.id, units: 11 })],
  ])("refuses to reuse a request ID with %s", async (_label, payload) => {
    const before = await readCounters(account.id, user.id, OCTOBER);

    await expectAppError(
      service.consume(account.id, { ...payload(), requestId: "svc-accept" }),
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual(before);
    expect(await countDecisions(account.id, "svc-accept")).toBe(1);
  });

  it("answers another account's user like an unknown user and writes nothing", async () => {
    const decisionsBefore = await countDecisions(account.id);
    const countersBefore = await countCounterRows(account.id);

    await expectAppError(
      service.consume(account.id, { userId: otherUser.id, units: 1, requestId: "svc-foreign" }),
      "NOT_FOUND",
      "User not found",
    );
    await expectAppError(
      service.consume(account.id, {
        userId: "00000000-0000-4000-8000-000000000000",
        units: 1,
        requestId: "svc-unknown",
      }),
      "NOT_FOUND",
      "User not found",
    );
    expect(await countDecisions(account.id)).toBe(decisionsBefore);
    expect(await countCounterRows(account.id)).toBe(countersBefore);
    expect(await countCounterRows(other.id)).toBe(0);
  });

  it("lets another account use the same request ID independently", async () => {
    const decision = await service.consume(other.id, {
      userId: otherUser.id,
      units: 5,
      requestId: "svc-accept",
    });

    expect(decision).toMatchObject({ accepted: true, userId: otherUser.id, units: 5 });
    expect(await readCounters(other.id, otherUser.id, OCTOBER)).toEqual({ account: 5, user: 5 });
  });

  it("counts a new month from zero and keeps the previous month", async () => {
    now = new Date("2026-11-01T00:00:00.000Z");

    const november = await service.consume(account.id, {
      userId: user.id,
      units: 3,
      requestId: "svc-november",
    });

    expect(november).toMatchObject({
      month: "2026-11-01",
      account: { usedBefore: 0 },
      user: { usedBefore: 0 },
    });
    expect(await readCounters(account.id, user.id, "2026-11-01")).toEqual({
      account: 3,
      user: 3,
    });
    expect(await readCounters(account.id, user.id, OCTOBER)).toEqual({ account: 12, user: 12 });
  });
});

describe("schema alignment", () => {
  it("uses exactly the rule and level values of the database enums", async () => {
    const enums = await withTestClient(async (client) => {
      const result = await client.query<{ name: string; values: string[] }>(
        `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname IN ('quota_rule', 'quota_level')
         GROUP BY t.typname`,
      );
      return new Map(result.rows.map((row) => [row.name, [...row.values].sort()]));
    });

    expect(enums.get("quota_rule")).toEqual([...QUOTA_RULES].sort());
    expect(enums.get("quota_level")).toEqual([...QUOTA_LEVELS].sort());
  });
});
