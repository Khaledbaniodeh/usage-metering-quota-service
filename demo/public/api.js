/**
 * The demo UI's only network code. Every call goes to the same origin (the demo server), which
 * forwards it to the API. The API key is passed in per call and placed only in the X-API-Key
 * header: never in a URL, the result, storage, cookies or a log.
 */
import { toQueryString } from "./helpers.js";

/**
 * @typedef {object} ApiResult
 * @property {string} method
 * @property {string} path
 * @property {Readonly<Record<string, string | undefined>>} query
 * @property {boolean} ok true for a 2xx status
 * @property {number} status 0 when no response arrived
 * @property {string} text the raw response body, for byte-for-byte replay comparisons
 * @property {any} data the parsed JSON body, or null
 * @property {string | null} retryAfter the Retry-After header, if any
 * @property {number} durationMs
 * @property {boolean} networkError true when the demo server did not answer at all
 */

/**
 * @param {{ fetch: typeof globalThis.fetch, now: () => number }} dependencies
 */
export function createApiCaller({ fetch, now }) {
  /**
   * @param {{ method?: string, path: string, query?: Readonly<Record<string, string | undefined>>, body?: unknown, apiKey?: string | null }} request
   * @returns {Promise<ApiResult>}
   */
  return async function callApi({ method = "GET", path, query = {}, body, apiKey = null }) {
    const headers = { accept: "application/json" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (typeof apiKey === "string" && apiKey !== "") {
      headers["x-api-key"] = apiKey;
    }
    const base = { method, path, query };
    const started = now();
    try {
      const response = await fetch(`${path}${toQueryString(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      const text = await response.text();
      return {
        ...base,
        ok: response.ok,
        status: response.status,
        text,
        data: parseJson(text),
        retryAfter: response.headers.get("retry-after"),
        durationMs: Math.round(now() - started),
        networkError: false,
      };
    } catch {
      return {
        ...base,
        ok: false,
        status: 0,
        text: "",
        data: null,
        retryAfter: null,
        durationMs: Math.round(now() - started),
        networkError: true,
      };
    }
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
