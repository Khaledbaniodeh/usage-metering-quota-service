/**
 * Pure presentation helpers for the demo UI: no DOM, no network, no stored state. The browser
 * loads them through app.js, and the unit tests import them directly.
 *
 * Nothing here decides anything about quotas, plans or access. The API makes every decision;
 * these functions only build request values and format the API's responses for display.
 */

/** The API's documented requestId rule, shown as advice next to the field. */
export const REQUEST_ID_RULE = "1-128 characters from A-Z a-z 0-9 . _ : -";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A new idempotency key such as "demo-0f8fad5b-d9cb-469f-a165-70867728950e".
 *
 * @param {() => string} randomUUID crypto.randomUUID in the browser
 */
export function newRequestId(randomUUID) {
  return `demo-${randomUUID()}`;
}

/**
 * Advice only: the UI still sends whatever was entered, so the presenter can show the service's
 * own 400 response. Returns null when the value follows the documented rule.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function requestIdAdvice(value) {
  if (value === "") {
    return "Empty: the service requires a requestId and will answer 400.";
  }
  if (!REQUEST_ID_PATTERN.test(value)) {
    return `The service accepts ${REQUEST_ID_RULE}; it will answer 400 for this value.`;
  }
  return null;
}

/**
 * Turns the text of a numeric form field into the JSON value sent to the API, without
 * validating it: "" leaves the field out, a number is sent as a JSON number (10.5 and 0 included)
 * and anything else is sent as the text itself. The API decides what is valid.
 *
 * @param {string} text
 * @returns {number | string | undefined}
 */
export function toJsonNumber(text) {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : trimmed;
}

/**
 * Builds "?a=1&b=2" from the entries whose value is a non-empty string, in the given order.
 *
 * @param {Readonly<Record<string, string | undefined>>} params
 */
export function toQueryString(params) {
  return joinQuery(params, (_name, value) => encodeURIComponent(value));
}

function joinQuery(params, formatValue) {
  const pairs = Object.entries(params)
    .filter(([, value]) => typeof value === "string" && value !== "")
    .map(([name, value]) => `${encodeURIComponent(name)}=${formatValue(name, value ?? "")}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/**
 * One line describing a request for the diagnostics area, for example
 * "GET /v1/history?limit=5&cursor=eyJ2IjoxLCJr… → 200 · 12 ms". Long cursors are shortened.
 * Headers (and so the API key) are never part of it.
 *
 * @param {{ method: string, path: string, query?: Readonly<Record<string, string | undefined>>, status?: number, durationMs?: number, networkError?: boolean }} request
 */
export function describeRequest(request) {
  const query = joinQuery(request.query ?? {}, (name, value) =>
    name === "cursor" && value.length > 16
      ? `${encodeURIComponent(value.slice(0, 16))}…`
      : encodeURIComponent(value),
  );
  const target = `${request.method} ${request.path}${query}`;
  if (request.networkError === true) {
    return `${target} → no response`;
  }
  if (request.status === undefined) {
    return target;
  }
  const timing = request.durationMs === undefined ? "" : ` · ${String(request.durationMs)} ms`;
  return `${target} → ${String(request.status)}${timing}`;
}

/**
 * Pagination state for one list (users, users' usage or history). The first request carries the
 * filters; every continuation sends only `cursor` and `limit`, as the API requires, so the
 * presenter never copies a cursor by hand.
 *
 * @param {Readonly<Record<string, string | undefined>>} filters
 * @param {number} limit
 */
export function startPagination(filters, limit) {
  return { filters: { ...filters }, limit, items: [], nextCursor: null, pages: 0 };
}

/** Query of the first page: the filters and the page size. */
export function firstPageQuery(state) {
  return { ...state.filters, limit: String(state.limit) };
}

/** Query of the next page, or null when the last page was reached or nothing was loaded yet. */
export function nextPageQuery(state) {
  return state.nextCursor === null
    ? null
    : { cursor: state.nextCursor, limit: String(state.limit) };
}

/** Whether a list was loaded and its last page announced another one. */
export function hasNextPage(state) {
  return state !== null && state !== undefined && state.nextCursor !== null;
}

/**
 * Appends one page. A missing or empty nextCursor ends the list.
 *
 * @param {ReturnType<typeof startPagination>} state
 * @param {readonly unknown[]} items
 * @param {unknown} nextCursor
 */
export function addPage(state, items, nextCursor) {
  return {
    ...state,
    items: [...state.items, ...items],
    nextCursor: typeof nextCursor === "string" && nextCursor !== "" ? nextCursor : null,
    pages: state.pages + 1,
  };
}

const RULE_LABELS = new Map([
  ["MAX_UNITS_PER_REQUEST", "maximum units per request"],
  ["MONTHLY_ALLOWANCE", "monthly allowance"],
]);

/**
 * What the presenter needs from a consume decision, taken as-is from the API's response.
 *
 * @param {any} decision the body of POST /v1/consume, or one entry of GET /v1/history
 */
export function summarizeDecision(decision) {
  const accepted = decision.accepted === true;
  const rule = decision.blockingRule ?? null;
  const level = decision.blockingLevel ?? null;
  return {
    accepted,
    outcome: accepted ? "Accepted" : "Rejected",
    requestId: decision.requestId,
    userId: decision.userId,
    units: decision.units,
    month: decision.month,
    processedAt: decision.processedAt,
    blockingRule: rule,
    blockingLevel: level,
    blockedBy: accepted ? null : `${String(level)} ${String(rule)}`,
    explanation: accepted
      ? "The units were counted for the user and for the account."
      : `Blocked by the ${level === "USER" ? "user" : "account"} plan's ${RULE_LABELS.get(rule) ?? String(rule)}. Nothing was counted.`,
    levels: [
      summarizeLevel("User plan", "USER", decision.user, !accepted && level === "USER"),
      summarizeLevel("Account plan", "ACCOUNT", decision.account, !accepted && level === "ACCOUNT"),
    ],
  };
}

function summarizeLevel(label, scope, level, blocking) {
  return {
    label,
    scope,
    blocking,
    planName: level?.planName,
    used: level?.used,
    remaining: level?.remaining,
    monthlyAllowance: level?.monthlyAllowance,
    maxUnitsPerRequest: level?.maxUnitsPerRequest,
    percentUsed: percentUsed(level?.used, level?.monthlyAllowance),
  };
}

/**
 * A usage response: the current month carries the live plan's limits, a past month only `used`.
 *
 * @param {any} usage the body of GET /v1/usage or GET /v1/users/{userId}/usage
 */
export function summarizeUsage(usage) {
  const currentMonth = typeof usage.monthlyAllowance === "number";
  return {
    month: usage.month,
    used: usage.used,
    currentMonth,
    monthlyAllowance: currentMonth ? usage.monthlyAllowance : null,
    maxUnitsPerRequest: currentMonth ? usage.maxUnitsPerRequest : null,
    remaining: currentMonth ? usage.remaining : null,
    percentUsed: currentMonth ? percentUsed(usage.used, usage.monthlyAllowance) : null,
  };
}

/** Share of the allowance used, 0-100, for a progress bar. */
function percentUsed(used, allowance) {
  if (typeof used !== "number" || typeof allowance !== "number" || allowance <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((used / allowance) * 100));
}

const API_KEY_LIKE = /umqs_[A-Za-z0-9_-]{8,}/g;

/** Replaces anything shaped like a service API key. */
export function redactText(text) {
  return text.replace(API_KEY_LIKE, "umqs_[hidden]");
}

/**
 * A copy of a JSON value that is safe to display: every `apiKey` property is replaced and every
 * key-shaped string is redacted, at any depth.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSecrets(value) {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        name === "apiKey" ? "[hidden]" : redactSecrets(item),
      ]),
    );
  }
  return value;
}

/** The same object without its `apiKey` property (the account-creation response). */
export function withoutApiKey(value) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== "apiKey"));
}

/** A service message, made safe to show: no key-shaped text, no control characters, bounded. */
function safeMessage(message) {
  const cleaned = redactText(message)
    .replace(/\p{Cc}/gu, " ")
    .trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

/**
 * Describes a failed call for the presenter: what kind of failure it is, a short title, and a
 * detail line. Uses the HTTP status and the service's stable error code; the service's message is
 * shown only after it is made safe. Never includes headers, the API key or a stack trace.
 *
 * Kinds: validation, auth, not-found, idempotency, conflict, request, busy, unavailable, server,
 * upstream (the demo server could not reach the API), proxy (the demo server refused the
 * request), network (no answer from the demo server) and unexpected.
 *
 * @param {{ status: number, data: any, networkError?: boolean, retryAfter?: string | null }} result
 */
export function describeFailure(result) {
  if (result.networkError === true) {
    return failure(
      "network",
      "Network error",
      "The demo server did not answer. Is `npm run demo` still running?",
      {
        retryable: true,
      },
    );
  }
  const { status } = result;
  const code = typeof result.data?.error?.code === "string" ? result.data.error.code : null;
  const message =
    typeof result.data?.error?.message === "string" ? safeMessage(result.data.error.message) : "";
  const meta = { status, code };
  /** The message as the start of a sentence (without a trailing full stop). */
  const lead = message.replace(/[.\s]+$/, "");

  if (code === "DEMO_UPSTREAM_UNAVAILABLE" || code === "DEMO_UPSTREAM_TIMEOUT") {
    return failure("upstream", "API not reachable", message, { ...meta, retryable: true });
  }
  if (code?.startsWith("DEMO_") === true) {
    return failure("proxy", "Refused by the demo server", message, meta);
  }
  if (code === null) {
    return failure(
      "unexpected",
      `Unexpected response (HTTP ${String(status)})`,
      "The response was not a service error body.",
      meta,
    );
  }

  switch (status) {
    case 400:
      return failure("validation", "Validation error", message, meta);
    case 401:
      return failure(
        "auth",
        "Missing or invalid API key",
        "The service did not accept the key. By design it does not say whether the key is missing, malformed or unknown.",
        meta,
      );
    case 404:
      return failure(
        "not-found",
        "Not found",
        `${lead}. An unknown ID and an ID that belongs to another account get the same answer.`,
        meta,
      );
    case 409:
      return code === "IDEMPOTENCY_CONFLICT"
        ? failure(
            "idempotency",
            "Idempotency conflict",
            `${lead}. Nothing was recorded. Send the original userId and units to replay the decision, or use a new requestId.`,
            meta,
          )
        : failure("conflict", "Conflict", message, meta);
    case 413:
    case 415:
      return failure("request", "Request not accepted", message, meta);
    case 503:
      return code === "BUSY_RETRY"
        ? failure(
            "busy",
            "Busy: retry the same request",
            `${lead}. Nothing was recorded.${result.retryAfter ? ` Retry after ${result.retryAfter} s.` : ""}`,
            { ...meta, retryable: true },
          )
        : failure("unavailable", "Service not ready", message, { ...meta, retryable: true });
    case 500:
      return failure(
        "server",
        "Internal error",
        "The service reported an internal error without details. For a consume request the outcome is unknown; retrying with the same requestId is safe.",
        { ...meta, retryable: true },
      );
    default:
      return failure("unexpected", `Unexpected response (HTTP ${String(status)})`, message, meta);
  }
}

function failure(kind, title, detail, { status = null, code = null, retryable = false } = {}) {
  return { kind, title, detail, status, code, retryable };
}

/** "10,000"; "—" for a missing value. */
export function formatNumber(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

/** "2026-11-27 14:05:31 UTC" from an ISO timestamp; the text itself when it is not one. */
export function formatTimestamp(iso) {
  return typeof iso === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
    : String(iso ?? "—");
}

/** The first 8 characters of an ID, for compact tables; the full ID is shown on hover. */
export function shortId(id) {
  return typeof id === "string" && id.length > 9 ? `${id.slice(0, 8)}…` : String(id ?? "—");
}

/** A unique, valid default account name such as "Interview demo 2026-11-27 14:05:31". */
export function defaultAccountName(date) {
  return `Interview demo ${date.toISOString().slice(0, 19).replace("T", " ")}`;
}

/** The masked form of an API key: only the public prefix, no character of the secret. */
export const MASKED_API_KEY = `umqs_${"•".repeat(20)}`;

/** "Predefined" for the four built-in plans (they have a code), "Custom" for account-owned ones. */
export function planKind(plan) {
  return plan.code === null ? "Custom" : "Predefined";
}
