import { describe, expect, it } from "vitest";
import type { ConsumeResult } from "../../../client/api-client.js";
import {
  EXIT_CONFIGURATION,
  EXIT_OK,
  EXIT_WORKFLOW_FAILED,
  newRunId,
  runCli,
  summaryLine,
} from "../../../client/cli.js";
import { replayMismatch } from "../../../client/workflow.js";
import { fakeFetch, json, sampleApiKey, type RecordedRequest } from "../../helpers/fake-fetch.js";
import { fakeQuotaService } from "../../helpers/fake-quota-service.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const USER_IDS = [1, 2, 3].map((n) => `22222222-2222-4222-8222-00000000000${String(n)}`);
const [BASIC_USER = "", PREMIUM_USER = ""] = USER_IDS;
const SHARED_PLAN_ID = "c0000000-0000-4000-8000-000000000001";
const STARTER_ID = "a0000000-0000-4000-8000-000000000001";
const BASIC_ID = "b0000000-0000-4000-8000-000000000001";

/** Every line a correct run prints, in order. The retry line names the response's byte length. */
const PASSING_OUTPUT = [
  "Example client: running the workflow against http://127.0.0.1:8080",
  "[ok] health: live and ready",
  `[ok] create account: ${ACCOUNT_ID} on plan Starter (10000/month, 100/request)`,
  "[ok] create users: 3 users on plan Basic",
  "[ok] find the predefined user plans: Basic (1000/month, 20/request), Premium (10000/month, 100/request)",
  `[ok] switch user 2 to Premium: ${PREMIUM_USER} now on plan Premium (10000/month, 100/request)`,
  "[ok] users on different plans: user 1 on Basic (1000/month, 20/request), user 2 on Premium (10000/month, 100/request), both read with this account's key",
  '[ok] accepted request: run-basic-accepted: ACCEPTED 10 units | user "Basic" 10 used, 990 remaining | account "Starter" 10 used, 9990 remaining',
  expect.stringMatching(
    /^\[ok\] idempotent retry: identical response \(\d+ bytes\); account usage still 10$/,
  ),
  '[ok] user-limit rejection: run-basic-rejected: REJECTED 25 units by USER MAX_UNITS_PER_REQUEST | user "Basic" 10 used, 990 remaining | account "Starter" 10 used, 9990 remaining; Basic allows 20 per request; nothing was counted',
  '[ok] Premium user allowed the same amount: run-premium-accepted: ACCEPTED 25 units | user "Premium" 25 used, 9975 remaining | account "Starter" 35 used, 9965 remaining; Premium allows 100 per request',
  `[ok] create a shared account plan: ${SHARED_PLAN_ID} "Example shared cap" (35/month, 100/request): the account's usage so far`,
  '[ok] assign it to the account: account now on "Example shared cap": 35 of 35 used, 0 remaining',
  '[ok] account-limit rejection: run-account-rejected: REJECTED 5 units by ACCOUNT MONTHLY_ALLOWANCE | user "Premium" 25 used, 9975 remaining | account "Example shared cap" 35 used, 0 remaining; user plan alone would allow it (5 <= 100 per request, 9975 remaining); nothing was counted',
  '[ok] raise the shared plan: "Example shared cap" monthly allowance 35 -> 40',
  '[ok] accepted after the plan update: run-account-accepted: ACCEPTED 5 units | user "Premium" 30 used, 9970 remaining | account "Example shared cap" 40 used, 0 remaining; the 5 units the shared limit rejected before',
  '[ok] account usage: 40 units used in 2026-10, 0 remaining on "Example shared cap" (accepted requests only)',
  "[ok] user usage: 10 + 30 + 0 = 40 units, the account's total",
  "[ok] walk GET /v1/users: 3 users in 3 pages, plans Basic, Premium, Basic",
  "[ok] walk GET /v1/usage/users: 3 users in 3 pages, live plan and limits checked",
  "[ok] walk GET /v1/history: 5 decisions in 5 pages, each as originally returned",
  `Example workflow passed: account ${ACCOUNT_ID}, month 2026-10, 3 users, 3 accepted and 2 rejected decisions, 40 units used; walked 3/3/5 pages (users/usage/history).`,
];

async function run(
  env: Record<string, string | undefined>,
  service?: { readonly fetch: ReturnType<typeof fakeFetch>["fetch"] },
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli({
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    runId: "run",
    ...(service === undefined ? {} : { fetch: service.fetch }),
  });
  return { code, stdout, stderr, output: [...stdout, ...stderr].join("\n") };
}

/** The request ID of a consume call, or undefined for any other call. */
function requestIdOf(request: RecordedRequest): string | undefined {
  if (request.method !== "POST" || request.url.pathname !== "/v1/consume") {
    return undefined;
  }
  return (JSON.parse(request.body ?? "{}") as { requestId?: string }).requestId;
}

/** A fake service whose response to calls matching `matches` is replaced by `change(body)`. */
function tampered(
  matches: (call: string, request: RecordedRequest) => boolean,
  change: (body: Record<string, unknown>) => unknown,
) {
  return fakeQuotaService({
    tamper: (call, body, request) =>
      matches(call, request) ? change(body as Record<string, unknown>) : body,
  });
}

/** Expects a failed run whose first error line names `step` and contains `fragment`. */
async function expectFailure(
  service: ReturnType<typeof fakeQuotaService>,
  step: string,
  fragment: string,
) {
  const result = await run({}, service);

  expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
  expect(result.stderr[0]).toContain(`Example client failed at step "${step}": `);
  expect(result.stderr[0]).toContain(fragment);
  // The steps before it passed, and nothing after it ran.
  expect(result.stdout.at(-1)).not.toMatch(/^Example workflow passed/);
  expect(result.output).not.toMatch(/umqs_[A-Za-z0-9_-]{8}/);
  return result;
}

describe("the required scenario", () => {
  it("passes against a correct service and prints every decision with its allowances", async () => {
    const service = fakeQuotaService();

    const result = await run({}, service);

    expect(result.stderr).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toEqual(PASSING_OUTPUT);
  });

  it("makes exactly the documented calls, in order", async () => {
    const service = fakeQuotaService();

    await run({}, service);

    const calls = service.requests.map(
      (request) => `${request.method} ${request.url.pathname}${request.url.search}`,
    );
    expect(calls).toEqual([
      "GET /health/live",
      "GET /health/ready",
      "POST /v1/accounts",
      "POST /v1/users",
      "POST /v1/users",
      "POST /v1/users",
      "GET /v1/plans?scope=USER",
      `PUT /v1/users/${PREMIUM_USER}/plan`,
      `GET /v1/users/${BASIC_USER}`,
      `GET /v1/users/${PREMIUM_USER}`,
      "POST /v1/consume",
      "POST /v1/consume",
      "GET /v1/usage",
      "POST /v1/consume",
      "POST /v1/consume",
      "POST /v1/plans",
      "PUT /v1/account/plan",
      "GET /v1/usage",
      "POST /v1/consume",
      `PATCH /v1/plans/${SHARED_PLAN_ID}`,
      "POST /v1/consume",
      "GET /v1/usage",
      ...USER_IDS.map((id) => `GET /v1/users/${id}/usage?month=2026-10`),
      "GET /v1/users?limit=1",
      "GET /v1/users?limit=1&cursor=at-1",
      "GET /v1/users?limit=1&cursor=at-2",
      "GET /v1/usage/users?month=2026-10&limit=1",
      "GET /v1/usage/users?limit=1&cursor=at-1",
      "GET /v1/usage/users?limit=1&cursor=at-2",
      "GET /v1/history?limit=1",
      ...[1, 2, 3, 4].map((n) => `GET /v1/history?limit=1&cursor=at-${String(n)}`),
    ]);
    expect(service.requests.map(requestIdOf).filter((id) => id !== undefined)).toEqual([
      "run-basic-accepted",
      "run-basic-accepted",
      "run-basic-rejected",
      "run-premium-accepted",
      "run-account-rejected",
      "run-account-accepted",
    ]);
    // The new plan's monthly allowance is exactly the account's usage so far, then raised by 5.
    const planBodies = service.requests
      .filter((request) => request.url.pathname.startsWith("/v1/plans") && request.body !== null)
      .map((request) => JSON.parse(request.body ?? "") as unknown);
    expect(planBodies).toEqual([
      {
        name: "Example shared cap",
        scope: "ACCOUNT",
        monthlyAllowance: 35,
        maxUnitsPerRequest: 100,
      },
      { monthlyAllowance: 40 },
    ]);
  });

  it("sends the key only in the X-API-Key header and never prints it", async () => {
    const service = fakeQuotaService();

    const result = await run({}, service);

    const apiKey = service.apiKey();
    const authenticated = service.requests.filter(
      (request) => request.headers["x-api-key"] !== undefined,
    );
    expect(authenticated.length).toBeGreaterThan(20);
    expect(authenticated.every((request) => request.headers["x-api-key"] === apiKey)).toBe(true);
    expect(service.requests.some((request) => request.body?.includes(apiKey))).toBe(false);
    expect(result.output).not.toContain(apiKey);
    expect(result.output).not.toMatch(/umqs_[A-Za-z0-9_-]{8}/);
  });
});

describe("each required behavior fails the run when the service gets it wrong", () => {
  it("users on different plans: user 2 is still on Basic", async () => {
    await expectFailure(
      tampered(
        (call) => call === `GET /v1/users/${PREMIUM_USER}`,
        (user) => ({
          ...user,
          plan: {
            ...(user.plan as object),
            id: BASIC_ID,
            code: "basic",
            name: "Basic",
            monthlyAllowance: 1_000,
            maxUnitsPerRequest: 20,
          },
        }),
      ),
      "users on different plans",
      "user 2 [id, plan]",
    );
  });

  it("the switch to Premium did not take effect", async () => {
    await expectFailure(
      tampered(
        (call) => call === `PUT /v1/users/${PREMIUM_USER}/plan`,
        (user) => ({ ...user, plan: { ...(user.plan as object), code: "basic" } }),
      ),
      "switch user 2 to Premium",
      "user 2 plan after the switch",
    );
  });

  it("an accepted request that was rejected", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-basic-accepted",
        (decision) => ({
          ...decision,
          accepted: false,
          blockingRule: "MONTHLY_ALLOWANCE",
          blockingLevel: "USER",
        }),
      ),
      "accepted request",
      'decision run-basic-accepted outcome: expected [true,null,null], got [false,"MONTHLY_ALLOWANCE","USER"]',
    );
  });

  it("the user-limit rejection blamed on the account", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-basic-rejected",
        (decision) => ({ ...decision, blockingLevel: "ACCOUNT" }),
      ),
      "user-limit rejection",
      'outcome: expected [false,"MAX_UNITS_PER_REQUEST","USER"], got [false,"MAX_UNITS_PER_REQUEST","ACCOUNT"]',
    );
  });

  it("the user-limit rejection counted the units", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-basic-rejected",
        (decision) => ({
          ...decision,
          user: { ...(decision.user as object), used: 35, remaining: 965 },
        }),
      ),
      "user-limit rejection",
      "decision run-basic-rejected user [planId, planName, monthlyAllowance, maxUnitsPerRequest, used, remaining]",
    );
  });

  it("the Premium user's request was rejected like the Basic user's", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-premium-accepted",
        (decision) => ({
          ...decision,
          accepted: false,
          blockingRule: "MAX_UNITS_PER_REQUEST",
          blockingLevel: "USER",
        }),
      ),
      "Premium user allowed the same amount",
      "outcome",
    );
  });

  it("the shared-limit rejection blamed on the user", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-account-rejected",
        (decision) => ({ ...decision, blockingLevel: "USER" }),
      ),
      "account-limit rejection",
      'outcome: expected [false,"MONTHLY_ALLOWANCE","ACCOUNT"], got [false,"MONTHLY_ALLOWANCE","USER"]',
    );
  });

  it("the shared-limit rejection counted the units", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-account-rejected",
        (decision) => ({ ...decision, account: { ...(decision.account as object), used: 40 } }),
      ),
      "account-limit rejection",
      "decision run-account-rejected account",
    );
  });

  it("a wrong remaining allowance in a decision", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-premium-accepted",
        (decision) => ({
          ...decision,
          account: { ...(decision.account as object), remaining: 10_000 },
        }),
      ),
      "Premium user allowed the same amount",
      'account [planId, planName, monthlyAllowance, maxUnitsPerRequest, used, remaining]: expected ["a0000000-0000-4000-8000-000000000001","Starter",10000,100,35,9965]',
    );
  });

  it("the account plan switch did not take effect", async () => {
    await expectFailure(
      tampered(
        (call) => call === "PUT /v1/account/plan",
        (account) => ({ ...account, plan: { ...(account.plan as object), id: STARTER_ID } }),
      ),
      "assign it to the account",
      "account plan after the switch",
    );
  });

  it("the plan update was reported but not applied", async () => {
    // The PATCH response claims 40 units; the service keeps enforcing 35.
    const service = fakeQuotaService({
      intercept: (request) =>
        request.method === "PATCH"
          ? json(200, {
              id: SHARED_PLAN_ID,
              code: null,
              name: "Example shared cap",
              scope: "ACCOUNT",
              monthlyAllowance: 40,
              maxUnitsPerRequest: 100,
              createdAt: "2026-10-16T10:00:00.000Z",
              updatedAt: "2026-10-16T10:00:00.000Z",
            })
          : undefined,
    });

    await expectFailure(
      service,
      "accepted after the plan update",
      'decision run-account-accepted outcome: expected [true,null,null], got [false,"MONTHLY_ALLOWANCE","ACCOUNT"]',
    );
  });

  it("the plan update changed the wrong value", async () => {
    await expectFailure(
      tampered(
        (call) => call === `PATCH /v1/plans/${SHARED_PLAN_ID}`,
        (plan) => ({ ...plan, monthlyAllowance: 35 }),
      ),
      "raise the shared plan",
      "updated plan [id, monthlyAllowance, maxUnitsPerRequest]",
    );
  });

  it("the retry was counted twice", async () => {
    let usageCalls = 0;
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/usage" && (usageCalls += 1) === 1,
        (usage) => ({ ...usage, used: 20 }),
      ),
      "idempotent retry",
      "account usage after the retry: expected 10, got 20",
    );
  });

  it("the history holds a decision the run never made", async () => {
    let historyCalls = 0;
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/history" && (historyCalls += 1) === 5,
        (page) => {
          const [last] = page.decisions as Record<string, unknown>[];
          return { ...page, decisions: [last, { ...last, requestId: "run-extra" }] };
        },
      ),
      "walk GET /v1/history",
      "history, newest first",
    );
  });

  it("a history page repeats a decision", async () => {
    let historyCalls = 0;
    let firstPage: unknown;
    await expectFailure(
      fakeQuotaService({
        tamper: (call, body) => {
          if (call !== "GET /v1/history") {
            return body;
          }
          historyCalls += 1;
          const page = body as Record<string, unknown>;
          if (historyCalls === 1) {
            firstPage = page.decisions;
            return body;
          }
          return historyCalls === 2 ? { ...page, decisions: firstPage } : body;
        },
      }),
      "walk GET /v1/history",
      "item run-account-accepted was returned twice (page 2)",
    );
  });

  it("a history decision differs from its original response", async () => {
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/history",
        (page) => ({
          ...page,
          decisions: (page.decisions as Record<string, unknown>[]).map((decision) =>
            decision.requestId === "run-basic-accepted" ? { ...decision, units: 11 } : decision,
          ),
        }),
      ),
      "walk GET /v1/history",
      "history, newest first",
    );
  });

  it("a user's usage does not match the accepted decisions", async () => {
    await expectFailure(
      tampered(
        (call) => call === `GET /v1/users/${PREMIUM_USER}/usage`,
        (usage) => ({ ...usage, used: 25, remaining: 9_975 }),
      ),
      "user usage",
      "user 2 usage [month, used]: expected",
    );
  });

  it("the account total includes the rejected requests", async () => {
    let usageCalls = 0;
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/usage" && (usageCalls += 1) === 3,
        (usage) => ({ ...usage, used: 70, remaining: 0 }),
      ),
      "account usage",
      "account usage [month, used]: expected",
    );
  });

  it("the listed users do not show their current plans", async () => {
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/users",
        (page) => ({
          ...page,
          users: (page.users as Record<string, unknown>[]).map((user) => ({
            ...user,
            plan: { ...(user.plan as object), code: "basic" },
          })),
        }),
      ),
      "walk GET /v1/users",
      "users and their plans, oldest first",
    );
  });
});

describe("configuration", () => {
  it("rejects an invalid API_BASE_URL with exit code 2, without echoing it", async () => {
    const result = await run({ API_BASE_URL: "http://admin:hunter2@127.0.0.1:8080" });

    expect(result.code).toBe(EXIT_CONFIGURATION);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(["Example client: API_BASE_URL must not contain credentials"]);
    expect(result.output).not.toContain("hunter2");
  });

  it("defaults to http://127.0.0.1:8080 and accepts an explicit base URL", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));

    await run({}, down);
    await run({ API_BASE_URL: " http://api:8080/ " }, down);

    expect(down.requests.map((request) => request.url.origin)).toEqual([
      "http://127.0.0.1:8080",
      "http://api:8080",
    ]);
  });
});

describe("failures", () => {
  it("names the step and suggests starting the stack when the service is unreachable", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });

    const result = await run(
      {},
      fakeFetch(() => Promise.reject(failure)),
    );

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr).toEqual([
      'Example client failed at step "health": GET /health/live: could not reach the service at http://127.0.0.1:8080 (ECONNREFUSED)',
      "Is the service running? Start it with `docker compose up --wait`, or set API_BASE_URL.",
    ]);
  });

  it("reports a service that is not ready with its error code", async () => {
    const service = fakeQuotaService({
      intercept: (request) =>
        request.url.pathname === "/health/ready"
          ? json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Service is not ready" } })
          : undefined,
    });

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr).toEqual([
      'Example client failed at step "health": GET /health/ready: expected HTTP 200, got 503 SERVICE_UNAVAILABLE',
    ]);
  });

  it("never prints the API key, even when a later step fails", async () => {
    const service = fakeQuotaService({
      intercept: (request) =>
        request.method === "PATCH"
          ? json(500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } })
          : undefined,
    });

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr).toEqual([
      `Example client failed at step "raise the shared plan": PATCH /v1/plans/${SHARED_PLAN_ID}: expected HTTP 200, got 500 INTERNAL_ERROR`,
    ]);
    const apiKey = service.apiKey();
    // The key was used, but only in the header.
    expect(service.requests.at(-1)?.headers["x-api-key"]).toBe(apiKey);
    expect(result.output).not.toContain(apiKey);
    expect(result.output).not.toMatch(/umqs_[A-Za-z0-9_-]{8}/);
  });

  it("never echoes the service's error message", async () => {
    const service = fakeQuotaService({
      intercept: (request) =>
        request.url.pathname === "/health/ready"
          ? json(503, {
              error: { code: "SERVICE_UNAVAILABLE", message: "pool host db-7.internal down" },
            })
          : undefined,
    });

    const result = await run({}, service);

    expect(result.output).not.toContain("db-7.internal");
  });

  it("redacts a key-shaped value that reaches an assertion message", async () => {
    const leaked = sampleApiKey();
    const result = await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-basic-accepted",
        (decision) => ({ ...decision, requestId: leaked }),
      ),
      "accepted request",
      'got ["umqs_[REDACTED]"',
    );

    expect(result.output).not.toContain(leaked);
  });

  it("fails when the retry does not return the original response byte for byte", async () => {
    let consumes = 0;
    const service = fakeQuotaService({
      intercept: (request) => {
        if (requestIdOf(request) !== "run-basic-accepted" || (consumes += 1) === 1) {
          return undefined;
        }
        // The retry answers the same JSON value, serialized differently.
        return json(200, undefined, `${JSON.stringify(JSON.parse(request.body ?? "{}"))} `);
      },
    });

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr[0]).toMatch(
      /^Example client failed at step "idempotent retry": the retry returned a different response \(\d+ bytes, original \d+ bytes\)$/,
    );
  });
});

describe("usage representation", () => {
  /** Tampers the GET /v1/usage answers after the last decision (the 3rd and later calls). */
  function finalAccountUsage(change: (usage: Record<string, unknown>, call: number) => unknown) {
    let calls = 0;
    return fakeQuotaService({
      tamper: (call, body) => {
        if (call !== "GET /v1/usage") {
          return body;
        }
        calls += 1;
        return calls < 3 ? body : change(body as Record<string, unknown>, calls);
      },
    });
  }

  const pastForm = (usage: Record<string, unknown>) => ({ month: usage.month, used: usage.used });

  it("rejects the past-month form for the current month", async () => {
    await expectFailure(
      finalAccountUsage((usage, call) => (call === 3 ? pastForm(usage) : usage)),
      "account usage",
      "account usage: expected the current-month form, got the past-month form",
    );
  });

  it("rejects a partial usage shape", async () => {
    await expectFailure(
      finalAccountUsage((usage) => ({ ...usage, remaining: undefined })),
      "account usage",
      "account usage: monthlyAllowance, maxUnitsPerRequest and remaining must be all present or all absent (2 of 3 present)",
    );
  });

  it("rejects a usage list whose currentMonth disagrees with the other usage responses", async () => {
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/usage/users",
        (page) => ({ ...page, currentMonth: false }),
      ),
      "walk GET /v1/usage/users",
      "usage page 1 currentMonth: expected the current-month form, got the past-month form",
    );
  });

  it("rejects a current-month usage list item without its plan name", async () => {
    await expectFailure(
      tampered(
        (call) => call === "GET /v1/usage/users",
        (page) => ({
          ...page,
          users: (page.users as Record<string, unknown>[]).map((user) => ({
            ...user,
            planName: undefined,
          })),
        }),
      ),
      "walk GET /v1/usage/users",
      "planId and planName must be present exactly when the live limits are",
    );
  });

  it("asks for a rerun when the month had already changed at the usage check", async () => {
    await expectFailure(
      finalAccountUsage((usage) => ({ ...usage, month: "2026-11", used: 0 })),
      "account usage",
      "the UTC month changed during the run (the decisions are in 2026-10); run the example again",
    );
  });

  it("asks for a rerun when a later response changes form because the month changed", async () => {
    let userCalls = 0;
    let usageCalls = 0;
    const service = fakeQuotaService({
      tamper: (call, body) => {
        const usage = body as Record<string, unknown>;
        if (call === "GET /v1/usage") {
          usageCalls += 1;
          return usageCalls === 4 ? { ...usage, month: "2026-11", used: 0 } : body;
        }
        if (/^GET \/v1\/users\/[^/]+\/usage$/.test(call) && (userCalls += 1) === 1) {
          return pastForm(usage);
        }
        return body;
      },
    });

    await expectFailure(
      service,
      "user usage",
      "the UTC month changed during the run (the decisions are in 2026-10); run the example again",
    );
  });

  it("asks for a rerun when a decision falls into another month", async () => {
    await expectFailure(
      tampered(
        (_call, request) => requestIdOf(request) === "run-premium-accepted",
        (decision) => ({ ...decision, month: "2026-11" }),
      ),
      "Premium user allowed the same amount",
      "the UTC month changed during the run (the decisions are in 2026-10); run the example again",
    );
  });
});

describe("replayMismatch", () => {
  const original: ConsumeResult = {
    decision: {} as ConsumeResult["decision"],
    rawBody: '{"requestId":"a","units":5}',
  };

  it("accepts an identical body", () => {
    expect(replayMismatch(original, { ...original })).toBeUndefined();
  });

  it("rejects an equal value with different bytes", () => {
    expect(replayMismatch(original, { ...original, rawBody: '{"requestId":"a", "units":5}' })).toBe(
      "the retry returned a different response (28 bytes, original 27 bytes)",
    );
  });
});

describe("output", () => {
  it("summarizes a passed run with safe values only", () => {
    expect(
      summaryLine({
        accountId: ACCOUNT_ID,
        month: "2026-10",
        users: 3,
        acceptedDecisions: 3,
        rejectedDecisions: 2,
        unitsUsed: 40,
        pages: { users: 3, usage: 3, history: 5 },
      }),
    ).toBe(
      `Example workflow passed: account ${ACCOUNT_ID}, month 2026-10, 3 users, 3 accepted and 2 rejected decisions, 40 units used; walked 3/3/5 pages (users/usage/history).`,
    );
  });

  it("creates run IDs that are valid request ID material and unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId()));

    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/);
      // The longest request ID the workflow derives from it stays within the 128-character limit.
      expect(`${id}-premium-accepted`.length).toBeLessThanOrEqual(128);
    }
  });
});
