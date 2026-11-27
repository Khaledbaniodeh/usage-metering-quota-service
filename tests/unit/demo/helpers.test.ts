import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { CreateAccountBodySchema } from "../../../src/modules/accounts/account.schemas.js";
import { loadHelpersModule, randomApiKey, type FailureInput } from "./demo-modules.js";

const helpers = await loadHelpersModule();

/** The API's documented requestId rule (src/modules/consumption/consume.schemas.ts). */
const API_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function decision(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "demo-1",
    userId: "11111111-1111-4111-8111-111111111111",
    units: 10,
    accepted: true,
    blockingRule: null,
    blockingLevel: null,
    month: "2026-11",
    processedAt: "2026-11-27T10:15:30.123Z",
    account: {
      planId: "a0000000-0000-4000-8000-000000000001",
      planName: "Starter",
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 100,
      used: 2_500,
      remaining: 7_500,
    },
    user: {
      planId: "b0000000-0000-4000-8000-000000000001",
      planName: "Basic",
      monthlyAllowance: 1_000,
      maxUnitsPerRequest: 20,
      used: 10,
      remaining: 990,
    },
    ...overrides,
  };
}

describe("requestId helpers", () => {
  it("generates a fresh ID that follows the API's requestId rule", () => {
    const first = helpers.newRequestId(randomUUID);
    const second = helpers.newRequestId(randomUUID);

    expect(first).toMatch(/^demo-[0-9a-f-]{36}$/);
    expect(first).toMatch(API_REQUEST_ID);
    expect(second).not.toBe(first);
    expect(helpers.requestIdAdvice(first)).toBeNull();
    expect(helpers.newRequestId(() => "fixed")).toBe("demo-fixed");
  });

  it.each(["order-1001", "a.b_c:d-1", "x", "x".repeat(128)])("gives no advice for %s", (value) => {
    expect(helpers.requestIdAdvice(value)).toBeNull();
  });

  it.each(["", "has space", "a/b", "ünïcode", "x".repeat(129)])(
    "advises that the API will reject %j, matching the API's rule",
    (value) => {
      expect(API_REQUEST_ID.test(value)).toBe(false);
      expect(helpers.requestIdAdvice(value)).toMatch(/400/);
    },
  );
});

describe("form values", () => {
  it.each([
    ["", undefined],
    ["   ", undefined],
    ["10", 10],
    [" 25 ", 25],
    ["0", 0],
    ["-3", -3],
    ["10.5", 10.5],
    ["abc", "abc"],
  ])("sends the field %j as %j and leaves validation to the API", (text, expected) => {
    expect(helpers.toJsonNumber(text)).toBe(expected);
  });

  it("builds a query string from the non-empty values only, encoded", () => {
    expect(helpers.toQueryString({})).toBe("");
    expect(helpers.toQueryString({ month: undefined, userId: "" })).toBe("");
    expect(helpers.toQueryString({ month: "2026-10", limit: "5", note: "a b&c" })).toBe(
      "?month=2026-10&limit=5&note=a%20b%26c",
    );
  });

  it("builds a unique account name that satisfies the API's display-name rule", () => {
    const name = helpers.defaultAccountName(new Date("2026-11-27T14:05:31.456Z"));

    expect(name).toBe("Interview demo 2026-11-27 14:05:31");
    expect(name.length).toBeLessThanOrEqual(100);
    expect(Check(CreateAccountBodySchema, { name })).toBe(true);
  });
});

describe("pagination state", () => {
  it("sends the filters on the first page and only cursor and limit afterwards", () => {
    const start = helpers.startPagination({ month: "2026-10", userId: undefined }, 5);

    expect(helpers.toQueryString(helpers.firstPageQuery(start))).toBe("?month=2026-10&limit=5");
    expect(helpers.nextPageQuery(start)).toBeNull();
    expect(helpers.hasNextPage(start)).toBe(false);

    const first = helpers.addPage(start, ["a", "b"], "cursor-1");

    expect(helpers.hasNextPage(first)).toBe(true);
    expect(helpers.nextPageQuery(first)).toEqual({ cursor: "cursor-1", limit: "5" });
  });

  it("appends pages in order and ends at a null cursor", () => {
    const start = helpers.startPagination({}, 2);
    const first = helpers.addPage(start, ["a", "b"], "cursor-1");
    const last = helpers.addPage(first, ["c"], null);

    expect(last).toMatchObject({ items: ["a", "b", "c"], pages: 2, nextCursor: null });
    expect(helpers.nextPageQuery(last)).toBeNull();
    expect(helpers.hasNextPage(last)).toBe(false);
    // Earlier states are not modified.
    expect(start).toMatchObject({ items: [], pages: 0, nextCursor: null });
    expect(first.items).toEqual(["a", "b"]);
  });

  it.each([undefined, "", 42, {}])("treats a nextCursor of %j as the end of the list", (cursor) => {
    const state = helpers.addPage(helpers.startPagination({}, 5), ["a"], cursor);

    expect(state.nextCursor).toBeNull();
  });

  it("knows that nothing was loaded yet", () => {
    expect(helpers.hasNextPage(null)).toBe(false);
    expect(helpers.hasNextPage(undefined)).toBe(false);
  });
});

describe("decision summary", () => {
  it("summarizes an accepted decision from the response values", () => {
    const summary = helpers.summarizeDecision(decision());

    expect(summary).toMatchObject({
      accepted: true,
      outcome: "Accepted",
      requestId: "demo-1",
      units: 10,
      blockingRule: null,
      blockingLevel: null,
      blockedBy: null,
      explanation: "The units were counted for the user and for the account.",
    });
    expect(summary.levels).toEqual([
      {
        label: "User plan",
        scope: "USER",
        blocking: false,
        planName: "Basic",
        used: 10,
        remaining: 990,
        monthlyAllowance: 1_000,
        maxUnitsPerRequest: 20,
        percentUsed: 1,
      },
      {
        label: "Account plan",
        scope: "ACCOUNT",
        blocking: false,
        planName: "Starter",
        used: 2_500,
        remaining: 7_500,
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
        percentUsed: 25,
      },
    ]);
  });

  it("names the blocking rule and marks the user level for a user rejection", () => {
    const summary = helpers.summarizeDecision(
      decision({
        units: 25,
        accepted: false,
        blockingRule: "MAX_UNITS_PER_REQUEST",
        blockingLevel: "USER",
      }),
    );

    expect(summary).toMatchObject({
      accepted: false,
      outcome: "Rejected",
      blockedBy: "USER MAX_UNITS_PER_REQUEST",
      explanation: "Blocked by the user plan's maximum units per request. Nothing was counted.",
    });
    expect(summary.levels.map((level) => level.blocking)).toEqual([true, false]);
  });

  it("marks the account level for an account rejection and caps the meter at 100%", () => {
    const summary = helpers.summarizeDecision(
      decision({
        accepted: false,
        blockingRule: "MONTHLY_ALLOWANCE",
        blockingLevel: "ACCOUNT",
        account: {
          planName: "Shared cap",
          monthlyAllowance: 35,
          maxUnitsPerRequest: 100,
          used: 40,
          remaining: 0,
        },
      }),
    );

    expect(summary.blockedBy).toBe("ACCOUNT MONTHLY_ALLOWANCE");
    expect(summary.explanation).toBe(
      "Blocked by the account plan's monthly allowance. Nothing was counted.",
    );
    expect(summary.levels.map((level) => level.blocking)).toEqual([false, true]);
    expect(summary.levels[1]?.percentUsed).toBe(100);
  });

  it("summarizes current-month and past-month usage", () => {
    expect(
      helpers.summarizeUsage({
        month: "2026-11",
        used: 120,
        monthlyAllowance: 1_000,
        maxUnitsPerRequest: 20,
        remaining: 880,
      }),
    ).toEqual({
      month: "2026-11",
      used: 120,
      currentMonth: true,
      monthlyAllowance: 1_000,
      maxUnitsPerRequest: 20,
      remaining: 880,
      percentUsed: 12,
    });
    expect(helpers.summarizeUsage({ month: "2026-09", used: 340 })).toEqual({
      month: "2026-09",
      used: 340,
      currentMonth: false,
      monthlyAllowance: null,
      maxUnitsPerRequest: null,
      remaining: null,
      percentUsed: null,
    });
  });
});

describe("redaction", () => {
  it("replaces key-shaped text", () => {
    const apiKey = randomApiKey();

    expect(helpers.redactText(`key=${apiKey}; again ${apiKey}`)).toBe(
      "key=umqs_[hidden]; again umqs_[hidden]",
    );
    expect(helpers.redactText("umqs_short")).toBe("umqs_short");
  });

  it("removes apiKey properties and key-shaped strings at any depth without changing the input", () => {
    const apiKey = randomApiKey();
    const input = {
      id: "a-1",
      apiKey,
      plan: { name: "Starter", monthlyAllowance: 10_000, code: null },
      notes: [`see ${apiKey}`, 3, true],
    };

    const output = helpers.redactSecrets(input);

    expect(output).toEqual({
      id: "a-1",
      apiKey: "[hidden]",
      plan: { name: "Starter", monthlyAllowance: 10_000, code: null },
      notes: ["see umqs_[hidden]", 3, true],
    });
    expect(JSON.stringify(output)).not.toContain(apiKey);
    expect(input.apiKey).toBe(apiKey);
  });

  it("drops the apiKey property from the account-creation response", () => {
    const account = { id: "a-1", name: "Demo", apiKey: randomApiKey() };

    expect(helpers.withoutApiKey(account)).toEqual({ id: "a-1", name: "Demo" });
  });

  it("masks a key without any of its secret characters", () => {
    expect(helpers.MASKED_API_KEY.startsWith("umqs_")).toBe(true);
    expect(helpers.MASKED_API_KEY).not.toMatch(/umqs_[A-Za-z0-9_-]/);
  });
});

describe("failure descriptions", () => {
  function error(status: number, code: string, message = "Service message"): FailureInput {
    return { status, data: { error: { code, message } } };
  }

  it.each<[string, FailureInput, Partial<ReturnType<typeof helpers.describeFailure>>]>([
    [
      "a validation error",
      error(400, "VALIDATION_ERROR", "body/units must be integer"),
      {
        kind: "validation",
        title: "Validation error",
        detail: "body/units must be integer",
        retryable: false,
      },
    ],
    ["a missing or invalid key", error(401, "UNAUTHORIZED"), { kind: "auth", retryable: false }],
    [
      "an unknown or other account's resource",
      error(404, "NOT_FOUND", "User not found"),
      {
        kind: "not-found",
        detail:
          "User not found. An unknown ID and an ID that belongs to another account get the same answer.",
      },
    ],
    [
      "an idempotency conflict",
      error(409, "IDEMPOTENCY_CONFLICT"),
      { kind: "idempotency", title: "Idempotency conflict", code: "IDEMPOTENCY_CONFLICT" },
    ],
    [
      "another conflict",
      error(409, "PLAN_SCOPE_MISMATCH"),
      { kind: "conflict", code: "PLAN_SCOPE_MISMATCH" },
    ],
    ["an unsupported body", error(415, "UNSUPPORTED_MEDIA_TYPE"), { kind: "request" }],
    [
      "a busy answer",
      { ...error(503, "BUSY_RETRY", "Busy"), retryAfter: "1" },
      { kind: "busy", retryable: true, detail: "Busy. Nothing was recorded. Retry after 1 s." },
    ],
    [
      "a service that is not ready",
      error(503, "SERVICE_UNAVAILABLE"),
      { kind: "unavailable", retryable: true },
    ],
    ["an internal error", error(500, "INTERNAL_ERROR"), { kind: "server", retryable: true }],
    [
      "an unreachable API",
      error(502, "DEMO_UPSTREAM_UNAVAILABLE", "The demo server could not reach the API."),
      { kind: "upstream", retryable: true },
    ],
    ["a timed-out API", error(504, "DEMO_UPSTREAM_TIMEOUT"), { kind: "upstream", retryable: true }],
    [
      "a refusal by the demo server",
      error(404, "DEMO_ROUTE_NOT_ALLOWED"),
      { kind: "proxy", retryable: false },
    ],
    [
      "a response that is not a service error",
      { status: 502, data: null },
      { kind: "unexpected", title: "Unexpected response (HTTP 502)", code: null },
    ],
    [
      "no response at all",
      { status: 0, data: null, networkError: true },
      { kind: "network", status: null, retryable: true },
    ],
  ])("describes %s", (_label, result, expected) => {
    expect(helpers.describeFailure(result)).toMatchObject(expected);
  });

  it("keeps the HTTP status and the service's code", () => {
    expect(helpers.describeFailure(error(409, "IDEMPOTENCY_CONFLICT"))).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("never shows a key, control characters or an unbounded message", () => {
    const apiKey = randomApiKey();

    const failure = helpers.describeFailure(
      error(400, "VALIDATION_ERROR", `bad\n\tvalue ${apiKey} ${"x".repeat(500)}`),
    );

    expect(JSON.stringify(failure)).not.toContain(apiKey);
    expect(failure.detail).not.toMatch(/\p{Cc}/u);
    expect(failure.detail.startsWith("bad  value umqs_[hidden] xxx")).toBe(true);
    expect(failure.detail.length).toBeLessThanOrEqual(301);
  });
});

describe("request descriptions and formatting", () => {
  it("describes a request by method, path, query, status and time, shortening cursors", () => {
    expect(
      helpers.describeRequest({
        method: "GET",
        path: "/v1/history",
        query: { limit: "5", cursor: "eyJ2IjoxLCJrIjoiaGlzdG9yeSJ9-long-cursor", month: undefined },
        status: 200,
        durationMs: 12,
      }),
    ).toBe("GET /v1/history?limit=5&cursor=eyJ2IjoxLCJrIjoi… → 200 · 12 ms");
    expect(helpers.describeRequest({ method: "POST", path: "/v1/consume", status: 409 })).toBe(
      "POST /v1/consume → 409",
    );
    expect(
      helpers.describeRequest({ method: "GET", path: "/health/live", networkError: true }),
    ).toBe("GET /health/live → no response");
  });

  it("formats numbers, timestamps, IDs and plan kinds for display", () => {
    expect(helpers.formatNumber(100_000)).toBe("100,000");
    expect(helpers.formatNumber(undefined)).toBe("—");
    expect(helpers.formatTimestamp("2026-11-27T10:15:30.123Z")).toBe("2026-11-27 10:15:30 UTC");
    expect(helpers.formatTimestamp(undefined)).toBe("—");
    expect(helpers.shortId("11111111-1111-4111-8111-111111111111")).toBe("11111111…");
    expect(helpers.shortId("short")).toBe("short");
    expect(helpers.planKind({ code: "starter" })).toBe("Predefined");
    expect(helpers.planKind({ code: null })).toBe("Custom");
  });
});
