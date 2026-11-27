import { describe, expect, it } from "vitest";
import { loadApiModule, randomApiKey, type FetchLike } from "./demo-modules.js";

const { createApiCaller } = await loadApiModule();

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetch, calls };
}

function clock(...times: number[]) {
  return () => times.shift() ?? 0;
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

describe("demo API caller", () => {
  it("sends a public GET to the same origin with no key and no body", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ status: "ok" }));
    const callApi = createApiCaller({ fetch, now: clock(100, 112.4) });

    const result = await callApi({ path: "/health/live" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/health/live");
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      body: undefined,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(headersOf(calls[0])).toEqual({ accept: "application/json" });
    expect(result).toMatchObject({
      method: "GET",
      path: "/health/live",
      ok: true,
      status: 200,
      data: { status: "ok" },
      durationMs: 12,
      networkError: false,
    });
  });

  it("puts the key only in the X-API-Key header and sends the body as JSON", async () => {
    const apiKey = randomApiKey();
    const { fetch, calls } = fakeFetch(
      () => new Response('{"accepted":true}', { status: 200, headers: { "retry-after": "1" } }),
    );
    const callApi = createApiCaller({ fetch, now: clock(0, 5) });
    const body = { userId: "u-1", units: 10, requestId: "demo-1" };

    const result = await callApi({
      method: "POST",
      path: "/v1/consume",
      query: { limit: "5", month: undefined },
      body,
      apiKey,
    });

    expect(calls[0]?.url).toBe("/v1/consume?limit=5");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify(body));
    expect(headersOf(calls[0])).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    });
    expect(calls[0]?.url).not.toContain(apiKey);
    expect(result.text).toBe('{"accepted":true}');
    expect(result.retryAfter).toBe("1");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("returns the status and raw text of an error, with the parsed error body", async () => {
    const text = '{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"Already used"}}';
    const { fetch } = fakeFetch(() => new Response(text, { status: 409 }));
    const callApi = createApiCaller({ fetch, now: clock() });

    const result = await callApi({ method: "POST", path: "/v1/consume", body: {} });

    expect(result).toMatchObject({ ok: false, status: 409, text });
    expect(result.data).toEqual({
      error: { code: "IDEMPOTENCY_CONFLICT", message: "Already used" },
    });
  });

  it("keeps a body that is not JSON as text only", async () => {
    const { fetch } = fakeFetch(() => new Response("Bad Gateway", { status: 502 }));
    const callApi = createApiCaller({ fetch, now: clock() });

    const result = await callApi({ path: "/v1/account" });

    expect(result).toMatchObject({ ok: false, status: 502, text: "Bad Gateway", data: null });
  });

  it("reports a network failure without the key or the failure's message", async () => {
    const apiKey = randomApiKey();
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`Failed to fetch with ${apiKey}`);
    });
    const callApi = createApiCaller({ fetch, now: clock(0, 3) });

    const result = await callApi({ path: "/v1/account", apiKey });

    expect(result).toEqual({
      method: "GET",
      path: "/v1/account",
      query: {},
      ok: false,
      status: 0,
      text: "",
      data: null,
      retryAfter: null,
      durationMs: 3,
      networkError: true,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});
