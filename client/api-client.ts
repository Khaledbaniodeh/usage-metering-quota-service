import { ApiKey } from "./api-key.js";
import type {
  Account,
  ConsumeRequest,
  Decision,
  ErrorBody,
  HistoryPage,
  MonthlyUsage,
  PageQuery,
  User,
  UserPage,
  UserUsagePage,
} from "./api-types.js";

/**
 * A small typed client for the service's public HTTP API, built on Node's native fetch. It knows
 * only the documented endpoints and response shapes: no database, no service internals.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_TIMEOUT_MS = 10_000;

/** The subset of `fetch` the client uses; tests inject their own. */
export type FetchFunction = (url: URL, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Service root, e.g. `http://127.0.0.1:8080`. Must not carry credentials, a query or a hash. */
  readonly baseUrl: string;
  /** Per-request deadline covering the response and its body. */
  readonly timeoutMs?: number;
  readonly fetch?: FetchFunction;
}

export type ApiErrorKind = "status" | "timeout" | "network" | "response";

/**
 * One failed API call. The message names the endpoint call (method, documented path and the call's
 * own query) and what went wrong, with at most the service's error code. It never contains the
 * configured base URL, request headers, the API key, the service's error message or any other
 * response-body value.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly kind: ApiErrorKind,
    /** `METHOD /v1/endpoint?query` of the failed call, without the base URL. */
    readonly call: string,
    detail: string,
    /** HTTP status, when a response arrived. */
    readonly status?: number,
    /** The service's `error.code`, when the body was a standard error with a well-formed code. */
    readonly code?: string,
  ) {
    super(`${call}: ${detail}`);
  }
}

export interface ConsumeResult {
  readonly decision: Decision;
  /** The response body exactly as received, to compare retries byte for byte. */
  readonly rawBody: string;
}

/** Endpoints that need no API key. */
export interface PublicApi {
  readonly live: () => Promise<{ status: string }>;
  readonly ready: () => Promise<{ status: string }>;
  /** Creates an account. The key comes back wrapped, so it cannot be printed by accident. */
  readonly createAccount: (name: string) => Promise<{ account: Account; apiKey: ApiKey }>;
  /** The endpoints of one account, authenticated with its key. */
  readonly forAccount: (apiKey: ApiKey) => AccountApi;
}

export interface AccountApi {
  readonly createUser: (name: string) => Promise<User>;
  readonly listUsers: (query?: PageQuery) => Promise<UserPage>;
  readonly consume: (request: ConsumeRequest) => Promise<ConsumeResult>;
  readonly accountUsage: (month?: string) => Promise<MonthlyUsage>;
  readonly userUsage: (userId: string, month?: string) => Promise<MonthlyUsage>;
  readonly listUserUsage: (
    query?: PageQuery & { readonly month?: string },
  ) => Promise<UserUsagePage>;
  readonly listHistory: (
    query?: PageQuery & { readonly userId?: string; readonly month?: string },
  ) => Promise<HistoryPage>;
}

type QueryValues = Readonly<Record<string, string | number | undefined>>;

interface Call {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly expectedStatus: 200 | 201;
  readonly query?: QueryValues;
  readonly body?: unknown;
  readonly apiKey?: ApiKey;
}

/**
 * Validates the service root and normalizes it to end with "/", so paths resolve below it even
 * when the service is mounted under a prefix. The raw value is never echoed: it could be anything.
 */
export function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API_BASE_URL must be an absolute http:// or https:// URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API_BASE_URL must be an absolute http:// or https:// URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("API_BASE_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("API_BASE_URL must not contain a query or fragment");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function searchParams(query: QueryValues): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, String(value));
    }
  }
  return params;
}

/** `path` (e.g. "/v1/users") below `baseUrl`, with the defined query values. */
export function buildUrl(baseUrl: URL, path: string, query: QueryValues = {}): URL {
  const url = new URL(path.replace(/^\/+/, ""), baseUrl);
  url.search = searchParams(query).toString();
  return url;
}

/**
 * The diagnostic name of a call: method, documented endpoint path and the call's own query. It is
 * built without the base URL, so a configured host or path prefix never reaches an error message.
 */
export function callLabel(method: string, path: string, query: QueryValues = {}): string {
  const search = searchParams(query).toString();
  return `${method} ${path}${search === "" ? "" : `?${search}`}`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    isJsonObject(value) &&
    isJsonObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

/** Catalogue error codes and Node network error codes are upper-case words; nothing else is echoed. */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The service's error code from a standard error body, if well formed. Never its message. */
function serviceErrorCode(body: unknown): string | undefined {
  return isErrorBody(body) && CODE.test(body.error.code) ? body.error.code : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A short, safe hint from a network failure: only its error code (e.g. ECONNREFUSED). */
function networkHint(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isJsonObject(cause) && typeof cause.code === "string" ? cause.code : undefined;
  return code === undefined || !CODE.test(code) ? "" : ` (${code})`;
}

export function createApiClient(options: ApiClientOptions): PublicApi {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFunction: FetchFunction = options.fetch ?? ((url, init) => fetch(url, init));

  /** Sends one call; returns the JSON object body and its exact text, or throws ApiError. */
  async function send(call: Call): Promise<{ data: Record<string, unknown>; text: string }> {
    const url = buildUrl(baseUrl, call.path, call.query);
    // The request goes to the full URL (prefix included); diagnostics name only the endpoint.
    const label = callLabel(call.method, call.path, call.query);
    const headers: Record<string, string> = { accept: "application/json" };
    if (call.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (call.apiKey !== undefined) {
      headers["x-api-key"] = call.apiKey.reveal();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchFunction(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? null : JSON.stringify(call.body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      // The original error is deliberately not attached: only its code is kept.
      if (controller.signal.aborted) {
        throw new ApiError("timeout", label, `no response within ${String(timeoutMs)} ms`);
      }
      throw new ApiError(
        "network",
        label,
        `could not reach the service at ${baseUrl.origin}${networkHint(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = parseJson(text);
    if (response.status !== call.expectedStatus) {
      const code = serviceErrorCode(data);
      const got =
        code === undefined ? String(response.status) : `${String(response.status)} ${code}`;
      throw new ApiError(
        "status",
        label,
        `expected HTTP ${String(call.expectedStatus)}, got ${got}`,
        response.status,
        code,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new ApiError("response", label, "expected a JSON response", response.status);
    }
    if (!isJsonObject(data)) {
      throw new ApiError(
        "response",
        label,
        "the response body is not a JSON object",
        response.status,
      );
    }
    return { data, text };
  }

  /**
   * A GET returning the documented response type `T`. Shapes are taken on trust from the public
   * contract; the example workflow asserts every value it relies on.
   */
  async function get<T>(path: string, query: QueryValues, apiKey?: ApiKey): Promise<T> {
    const call: Call =
      apiKey === undefined
        ? { method: "GET", path, query, expectedStatus: 200 }
        : { method: "GET", path, query, expectedStatus: 200, apiKey };
    return (await send(call)).data as T;
  }

  function forAccount(apiKey: ApiKey): AccountApi {
    const userPath = (userId: string) => `/v1/users/${encodeURIComponent(userId)}`;
    return {
      createUser: async (name) => {
        const { data } = await send({
          method: "POST",
          path: "/v1/users",
          body: { name },
          expectedStatus: 201,
          apiKey,
        });
        return data as unknown as User;
      },
      listUsers: (query = {}) =>
        get<UserPage>("/v1/users", { limit: query.limit, cursor: query.cursor }, apiKey),
      consume: async (request) => {
        const { data, text } = await send({
          method: "POST",
          path: "/v1/consume",
          body: { userId: request.userId, units: request.units, requestId: request.requestId },
          expectedStatus: 200,
          apiKey,
        });
        return { decision: data as unknown as Decision, rawBody: text };
      },
      accountUsage: (month) => get<MonthlyUsage>("/v1/usage", { month }, apiKey),
      userUsage: (userId, month) =>
        get<MonthlyUsage>(`${userPath(userId)}/usage`, { month }, apiKey),
      listUserUsage: (query = {}) =>
        get<UserUsagePage>(
          "/v1/usage/users",
          { month: query.month, limit: query.limit, cursor: query.cursor },
          apiKey,
        ),
      listHistory: (query = {}) =>
        get<HistoryPage>(
          "/v1/history",
          { userId: query.userId, month: query.month, limit: query.limit, cursor: query.cursor },
          apiKey,
        ),
    };
  }

  return {
    live: () => get<{ status: string }>("/health/live", {}),
    ready: () => get<{ status: string }>("/health/ready", {}),
    createAccount: async (name) => {
      const { data } = await send({
        method: "POST",
        path: "/v1/accounts",
        body: { name },
        expectedStatus: 201,
      });
      // The key is wrapped at once and removed from the account object.
      const { apiKey, ...account } = data;
      if (typeof apiKey !== "string" || apiKey === "") {
        throw new ApiError("response", "POST /v1/accounts", "the response has no API key", 201);
      }
      return { account: account as unknown as Account, apiKey: new ApiKey(apiKey) };
    },
    forAccount,
  };
}
