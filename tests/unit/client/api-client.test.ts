import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ApiKey } from "../../../client/api-key.js";
import {
  ApiError,
  buildUrl,
  createApiClient,
  parseBaseUrl,
  type FetchFunction,
} from "../../../client/api-client.js";
import { fakeFetch, json, sampleApiKey, untilAborted } from "../../helpers/fake-fetch.js";

const BASE_URL = "http://127.0.0.1:8080";
const USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function client(fetch: FetchFunction, timeoutMs = 1_000) {
  return createApiClient({ baseUrl: BASE_URL, fetch, timeoutMs });
}

/** The rejection of `promise`, which must be an ApiError. */
async function apiErrorOf(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ApiError)) {
    throw new Error(`expected an ApiError, got ${String(error)}`);
  }
  return error;
}

/** Every way an error typically reaches output. */
function renderings(error: Error): string[] {
  return [error.message, String(error), error.stack ?? "", inspect(error, { depth: 5 })];
}

describe("base URL and paths", () => {
  it("accepts http and https roots and normalizes them to end with a slash", () => {
    expect(parseBaseUrl("http://127.0.0.1:8080").href).toBe("http://127.0.0.1:8080/");
    expect(parseBaseUrl("https://api.example.test/metering").href).toBe(
      "https://api.example.test/metering/",
    );
  });

  it.each([
    ["a relative URL", "/v1", "must be an absolute http:// or https:// URL"],
    ["another protocol", "ftp://example.test", "must be an absolute http:// or https:// URL"],
    ["credentials", "http://admin:hunter2@example.test", "must not contain credentials"],
    ["a query", "http://example.test/?debug=1", "must not contain a query or fragment"],
    ["a fragment", "http://example.test/#top", "must not contain a query or fragment"],
  ])("rejects %s without echoing the value", (_label, raw, message) => {
    expect(() => parseBaseUrl(raw)).toThrow(`API_BASE_URL ${message}`);
    try {
      parseBaseUrl(raw);
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });

  it("resolves paths below a prefix and adds only defined query values", () => {
    const url = buildUrl(parseBaseUrl("http://example.test/metering"), "/v1/history", {
      userId: USER_ID,
      month: undefined,
      limit: 1,
      cursor: "abc_-123",
    });

    expect(url.href).toBe(
      `http://example.test/metering/v1/history?userId=${USER_ID}&limit=1&cursor=abc_-123`,
    );
  });

  it("encodes query values", () => {
    const url = buildUrl(parseBaseUrl(BASE_URL), "/v1/users", { cursor: "a b&c=d" });

    expect(url.search).toBe("?cursor=a+b%26c%3Dd");
    expect(url.searchParams.get("cursor")).toBe("a b&c=d");
  });
});

describe("requests", () => {
  it("sends JSON bodies with the API key, and plain GETs without a body or key", async () => {
    const apiKey = sampleApiKey();
    const { fetch, requests } = fakeFetch((request) =>
      request.method === "GET"
        ? json(200, { status: "ok" })
        : json(201, { id: USER_ID, name: "Ada" }),
    );
    const api = client(fetch);

    await api.live();
    await api.forAccount(new ApiKey(apiKey)).createUser("Ada");

    const [live, create] = requests;
    expect(live?.method).toBe("GET");
    expect(live?.url.href).toBe(`${BASE_URL}/health/live`);
    expect(live?.body).toBeNull();
    expect(live?.headers).toEqual({ accept: "application/json" });

    expect(create?.method).toBe("POST");
    expect(create?.url.href).toBe(`${BASE_URL}/v1/users`);
    expect(create?.body).toBe('{"name":"Ada"}');
    expect(create?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    });
  });

  it("sends only the documented consume fields and keeps the exact response text", async () => {
    const decisionText = '{"requestId":"r-1",  "accepted":true}';
    const { fetch, requests } = fakeFetch(() => json(200, undefined, decisionText));
    const api = client(fetch).forAccount(new ApiKey(sampleApiKey()));

    const result = await api.consume({ userId: USER_ID, units: 5, requestId: "r-1" });

    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      userId: USER_ID,
      units: 5,
      requestId: "r-1",
    });
    expect(result.rawBody).toBe(decisionText);
    expect(result.decision).toEqual({ requestId: "r-1", accepted: true });
  });

  it("builds list and usage queries from the given options only", async () => {
    const { fetch, requests } = fakeFetch(() => json(200, {}));
    const api = client(fetch).forAccount(new ApiKey(sampleApiKey()));

    await api.listUsers({ limit: 1 });
    await api.listUserUsage({ month: "2026-10", cursor: "next" });
    await api.listHistory({ userId: USER_ID, limit: 100 });
    await api.accountUsage();
    await api.userUsage("id/with?special", "2026-09");

    expect(requests.map((request) => `${request.url.pathname}${request.url.search}`)).toEqual([
      "/v1/users?limit=1",
      "/v1/usage/users?month=2026-10&cursor=next",
      `/v1/history?userId=${USER_ID}&limit=100`,
      "/v1/usage",
      "/v1/users/id%2Fwith%3Fspecial/usage?month=2026-09",
    ]);
  });
});

describe("account creation", () => {
  it("returns the account without the key and the key wrapped", async () => {
    const apiKey = sampleApiKey();
    const { fetch } = fakeFetch(() => json(201, { id: "acc-1", name: "Acme", apiKey }));

    const created = await client(fetch).createAccount("Acme");

    expect(created.account).toEqual({ id: "acc-1", name: "Acme" });
    expect(created.apiKey.reveal()).toBe(apiKey);
    expect(JSON.stringify(created)).not.toContain(apiKey);
    expect(inspect(created, { depth: 5 })).not.toContain(apiKey);
  });

  it("fails clearly when the response carries no key", async () => {
    const { fetch } = fakeFetch(() => json(201, { id: "acc-1", name: "Acme" }));

    const error = await apiErrorOf(client(fetch).createAccount("Acme"));

    expect(error.kind).toBe("response");
    expect(error.message).toBe("POST /v1/accounts: the response has no API key");
  });
});

describe("expected status and error rendering", () => {
  it("renders the service's error code, never its message", async () => {
    const { fetch } = fakeFetch(() =>
      json(409, {
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "requestId was already used with a different payload",
        },
      }),
    );
    const api = client(fetch).forAccount(new ApiKey(sampleApiKey()));

    const error = await apiErrorOf(api.consume({ userId: USER_ID, units: 1, requestId: "r-1" }));

    expect(error).toMatchObject({ kind: "status", status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(error.message).toBe("POST /v1/consume: expected HTTP 200, got 409 IDEMPOTENCY_CONFLICT");
    for (const rendering of renderings(error)) {
      expect(rendering).not.toContain("already used");
    }
  });

  it.each([
    ["free text", "connection to 10.0.0.7 refused"],
    ["lower case", "not_found"],
    ["too long", `E${"X".repeat(64)}`],
  ])("does not echo an error code that is %s", async (_label, code) => {
    const { fetch } = fakeFetch(() => json(500, { error: { code, message: "detail" } }));

    const error = await apiErrorOf(client(fetch).ready());

    expect(error).toMatchObject({ kind: "status", status: 500, code: undefined });
    expect(error.message).toBe("GET /health/ready: expected HTTP 200, got 500");
  });

  it("rejects a success status other than the expected one", async () => {
    const { fetch } = fakeFetch(() => json(200, { id: USER_ID }));

    const error = await apiErrorOf(
      client(fetch).forAccount(new ApiKey(sampleApiKey())).createUser("Ada"),
    );

    expect(error.message).toBe("POST /v1/users: expected HTTP 201, got 200");
  });

  it("never copies a non-standard error body into the message", async () => {
    const { fetch } = fakeFetch(
      () => new Response("<html>upstream detail 10.0.0.7</html>", { status: 502 }),
    );

    const error = await apiErrorOf(client(fetch).ready());

    expect(error).toMatchObject({ kind: "status", status: 502, code: undefined });
    expect(error.message).toBe("GET /health/ready: expected HTTP 200, got 502");
  });
});

describe("malformed responses", () => {
  it.each([
    ["a non-JSON content type", () => new Response('{"status":"ok"}', { status: 200 })],
    [
      "an HTML page",
      () =>
        new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ],
  ])("rejects %s", async (_label, respond) => {
    const { fetch } = fakeFetch(respond);

    const error = await apiErrorOf(client(fetch).live());

    expect(error.kind).toBe("response");
    expect(error.message).toBe("GET /health/live: expected a JSON response");
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a JSON string", '"ok"'],
  ])("rejects %s without echoing it", async (_label, text) => {
    const { fetch } = fakeFetch(() => json(200, undefined, text));

    const error = await apiErrorOf(client(fetch).live());

    expect(error.kind).toBe("response");
    expect(error.message).toBe("GET /health/live: the response body is not a JSON object");
  });
});

describe("a base URL with a path prefix", () => {
  const PREFIX = "private-token-8c1f2e";
  const prefixed = (fetch: FetchFunction) =>
    createApiClient({ baseUrl: `https://example.test/${PREFIX}/`, fetch, timeoutMs: 20 });

  it("still sends every request below the prefix", async () => {
    const { fetch, requests } = fakeFetch(() => json(200, { users: [], nextCursor: null }));

    await prefixed(fetch).forAccount(new ApiKey(sampleApiKey())).listUsers({ limit: 1 });

    expect(requests[0]?.url.href).toBe(`https://example.test/${PREFIX}/v1/users?limit=1`);
  });

  it("names only the endpoint and its query in a diagnostic", async () => {
    const { fetch } = fakeFetch(() =>
      json(500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } }),
    );

    const error = await apiErrorOf(
      prefixed(fetch).forAccount(new ApiKey(sampleApiKey())).listUsers({ limit: 1 }),
    );

    expect(error.call).toBe("GET /v1/users?limit=1");
    expect(error.message).toBe("GET /v1/users?limit=1: expected HTTP 200, got 500 INTERNAL_ERROR");
  });

  const failures: [string, (signal: AbortSignal) => Response | Promise<Response>][] = [
    ["a status error", () => json(404, { error: { code: "NOT_FOUND", message: "Not found" } })],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a timeout", (signal) => untilAborted(signal)],
    ["a malformed response", () => json(200, undefined, "[]")],
  ];

  it.each(failures)("keeps the prefix out of %s", async (_label, respond) => {
    const { fetch, requests } = fakeFetch((_request, signal) => respond(signal));

    const error = await apiErrorOf(prefixed(fetch).live());

    expect(requests[0]?.url.pathname).toBe(`/${PREFIX}/health/live`);
    expect(error.call).toBe("GET /health/live");
    for (const rendering of [...renderings(error), JSON.stringify(error)]) {
      expect(rendering).not.toContain(PREFIX);
    }
  });
});

describe("timeouts and network failures", () => {
  it("aborts a request that gets no response within the deadline", async () => {
    let aborted = false;
    const { fetch } = fakeFetch((_request, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return untilAborted(signal);
    });

    const error = await apiErrorOf(client(fetch, 20).ready());

    expect(aborted).toBe(true);
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("GET /health/ready: no response within 20 ms");
  });

  it("applies the deadline to reading the body as well", async () => {
    const { fetch } = fakeFetch((_request, signal) => {
      const stalled = {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: () => untilAborted(signal),
      };
      return stalled as unknown as Response;
    });

    const error = await apiErrorOf(client(fetch, 20).live());

    expect(error.kind).toBe("timeout");
  });

  it("reports an unreachable service with only the error code", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
      }),
    });
    const { fetch } = fakeFetch(() => Promise.reject(failure));

    const error = await apiErrorOf(client(fetch).live());

    expect(error.kind).toBe("network");
    expect(error.message).toBe(
      "GET /health/live: could not reach the service at http://127.0.0.1:8080 (ECONNREFUSED)",
    );
    expect(error.cause).toBeUndefined();
  });
});

describe("the API key never reaches diagnostics", () => {
  const failures: [string, (signal: AbortSignal) => Response | Promise<Response>][] = [
    ["a status error", () => json(401, { error: { code: "UNAUTHORIZED", message: "no" } })],
    ["a malformed body", () => json(200, undefined, "[")],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a timeout", (signal) => untilAborted(signal)],
  ];

  it.each(failures)("keeps the key out of %s", async (_label, respond) => {
    const apiKey = sampleApiKey();
    const { fetch } = fakeFetch((_request, signal) => respond(signal));
    const api = client(fetch, 20).forAccount(new ApiKey(apiKey));

    const error = await apiErrorOf(api.listUsers({ limit: 1 }));

    for (const rendering of [...renderings(error), JSON.stringify(error)]) {
      expect(rendering).not.toContain(apiKey);
    }
  });
});
