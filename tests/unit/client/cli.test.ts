import { describe, expect, it } from "vitest";
import type { ConsumeResult } from "../../../client/api-client.js";
import {
  EXIT_CONFIGURATION,
  EXIT_WORKFLOW_FAILED,
  newRunId,
  runCli,
  summaryLine,
} from "../../../client/cli.js";
import { replayMismatch } from "../../../client/workflow.js";
import { fakeFetch, json, sampleApiKey, type RecordedRequest } from "../../helpers/fake-fetch.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const STARTER = {
  id: "a0000000-0000-4000-8000-000000000001",
  code: "starter",
  name: "Starter",
  scope: "ACCOUNT",
  monthlyAllowance: 10_000,
  maxUnitsPerRequest: 100,
};
const BASIC = {
  id: "b0000000-0000-4000-8000-000000000001",
  code: "basic",
  name: "Basic",
  scope: "USER",
  monthlyAllowance: 1_000,
  maxUnitsPerRequest: 20,
};

type Route = (request: RecordedRequest) => Response | Promise<Response> | undefined;

/**
 * Just enough of the service to reach the step under test: health, account creation (issuing
 * `apiKey`) and user creation. `route` answers first; anything unanswered is a test error.
 */
function scriptedService(apiKey: string, route: Route = () => undefined) {
  let users = 0;
  return fakeFetch((request) => {
    const answer = route(request);
    if (answer !== undefined) {
      return answer;
    }
    const call = `${request.method} ${request.url.pathname}`;
    switch (call) {
      case "GET /health/live":
        return json(200, { status: "ok" });
      case "GET /health/ready":
        return json(200, { status: "ready" });
      case "POST /v1/accounts":
        return json(201, { id: ACCOUNT_ID, name: "Example", plan: STARTER, apiKey });
      case "POST /v1/users":
        users += 1;
        return json(201, {
          id: `22222222-2222-4222-8222-00000000000${String(users)}`,
          name: `Example user ${String(users)}`,
          plan: BASIC,
        });
      default:
        throw new Error(`the scripted service does not answer ${call}`);
    }
  });
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "run-accepted-1",
    userId: "22222222-2222-4222-8222-000000000001",
    units: 5,
    accepted: true,
    blockingRule: null,
    blockingLevel: null,
    month: "2026-10",
    processedAt: "2026-10-14T10:00:00.000Z",
    account: { used: 5 },
    user: { used: 5 },
    ...overrides,
  };
}

async function run(env: Record<string, string | undefined>, fetch?: ReturnType<typeof fakeFetch>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli({
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    runId: "run",
    ...(fetch === undefined ? {} : { fetch: fetch.fetch }),
  });
  return { code, stdout, stderr, output: [...stdout, ...stderr].join("\n") };
}

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
    await run({ API_BASE_URL: " http://localhost:9000/ " }, down);

    expect(down.requests.map((request) => request.url.origin)).toEqual([
      "http://127.0.0.1:8080",
      "http://localhost:9000",
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
    const service = scriptedService(sampleApiKey(), (request) =>
      request.url.pathname === "/health/ready"
        ? json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Service is not ready" } })
        : undefined,
    );

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr).toEqual([
      'Example client failed at step "health": GET /health/ready: expected HTTP 200, got 503 SERVICE_UNAVAILABLE: Service is not ready',
    ]);
  });

  it("never prints the API key, even when a later step fails", async () => {
    const apiKey = sampleApiKey();
    const service = scriptedService(apiKey, (request) =>
      request.url.pathname === "/v1/users"
        ? json(500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } })
        : undefined,
    );

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr).toEqual([
      'Example client failed at step "create users": POST /v1/users: expected HTTP 201, got 500 INTERNAL_ERROR: Internal server error',
    ]);
    expect(result.stdout).toContain(`[ok] create account: ${ACCOUNT_ID} on plan Starter`);
    // The key was used, but only in the header.
    expect(service.requests.at(-1)?.headers["x-api-key"]).toBe(apiKey);
    expect(result.output).not.toContain(apiKey);
    expect(result.output).not.toMatch(/umqs_[A-Za-z0-9_-]{8}/);
  });

  it("redacts a key-shaped token that reaches a message from elsewhere", async () => {
    const leaked = sampleApiKey();
    const service = scriptedService(sampleApiKey(), (request) =>
      request.url.pathname === "/health/ready"
        ? json(503, { error: { code: "SERVICE_UNAVAILABLE", message: `bad key ${leaked}` } })
        : undefined,
    );

    const result = await run({}, service);

    expect(result.output).not.toContain(leaked);
    expect(result.stderr[0]).toContain("bad key umqs_[REDACTED]");
  });

  it("fails an accepted request that the service rejected, showing expected and actual", async () => {
    const service = scriptedService(sampleApiKey(), (request) =>
      request.url.pathname === "/v1/consume"
        ? json(
            200,
            decision({
              accepted: false,
              blockingRule: "MONTHLY_ALLOWANCE",
              blockingLevel: "USER",
            }),
          )
        : undefined,
    );

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr).toEqual([
      'Example client failed at step "accepted request": decision run-accepted-1 outcome: expected [true,null,null], got [false,"MONTHLY_ALLOWANCE","USER"]',
    ]);
  });

  it("fails when the retry does not return the original response byte for byte", async () => {
    let consumes = 0;
    const service = scriptedService(sampleApiKey(), (request) => {
      if (request.url.pathname !== "/v1/consume") {
        return undefined;
      }
      consumes += 1;
      const body = decision();
      // The same JSON value, serialized differently the second time.
      return json(200, body, consumes === 1 ? JSON.stringify(body) : JSON.stringify(body, null, 1));
    });

    const result = await run({}, service);

    expect(result.code).toBe(EXIT_WORKFLOW_FAILED);
    expect(result.stderr[0]).toMatch(
      /^Example client failed at step "idempotent retry": the retry returned a different response \(\d+ bytes, original \d+ bytes\)$/,
    );
  });
});

describe("replayMismatch", () => {
  const result = (rawBody: string): ConsumeResult => ({
    decision: JSON.parse(rawBody) as ConsumeResult["decision"],
    rawBody,
  });

  it("accepts an identical body", () => {
    expect(replayMismatch(result('{"a":1}'), result('{"a":1}'))).toBeUndefined();
  });

  it("rejects an equal value with different bytes", () => {
    expect(replayMismatch(result('{"a":1}'), result('{ "a": 1 }'))).toBe(
      "the retry returned a different response (10 bytes, original 7 bytes)",
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
        acceptedDecisions: 2,
        rejectedDecisions: 1,
        unitsUsed: 12,
        pages: { users: 3, usage: 3, history: 3 },
      }),
    ).toBe(
      `Example workflow passed: account ${ACCOUNT_ID}, month 2026-10, 3 users, 2 accepted and 1 rejected decisions, 12 units used; walked 3/3/3 pages (users/usage/history).`,
    );
  });

  it("creates run IDs that are valid request ID material and unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId()));

    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(`${id}-accepted-1`).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    }
  });
});
