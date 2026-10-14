import { randomBytes } from "node:crypto";
import type { FetchFunction } from "../../client/api-client.js";

/** A realistic API key: `umqs_` + 43 base64url characters. */
export function sampleApiKey(): string {
  return `umqs_${randomBytes(32).toString("base64url")}`;
}

export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

type Handler = (request: RecordedRequest, signal: AbortSignal) => Response | Promise<Response>;

/** A JSON response with the service's content type. */
export function json(status: number, body: unknown, text = JSON.stringify(body)): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** An in-process fetch that records every request and answers with `handler`. */
export function fakeFetch(handler: Handler): {
  readonly fetch: FetchFunction;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFunction = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : null,
    };
    requests.push(request);
    if (init.signal === null || init.signal === undefined) {
      throw new Error("the client must always pass an abort signal");
    }
    return handler(request, init.signal);
  };
  return { fetch, requests };
}

/** Resolves never; rejects as fetch does once `signal` aborts. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("This operation was aborted", "AbortError"));
    });
  });
}
