/**
 * Local server for the optional interview demo UI.
 *
 * It does exactly two things, using only Node's built-in modules:
 *
 * 1. Serves the files of demo/public/ from a fixed list. A URL is never turned into a file-system
 *    path, so there is nothing to traverse.
 * 2. Forwards /health/live, /health/ready and /v1/* to the one configured API (the real service),
 *    so the browser talks to a single origin and the service needs no CORS settings.
 *
 * It holds no quota, authentication, authorization or plan logic: every decision is made by the
 * API, and its status, body and safe headers are passed back unchanged. Proxy errors use their own
 * DEMO_* codes so they can never be mistaken for the service's error codes.
 *
 * Logged per forwarded request: method, path (without its query) and status. Never logged: request
 * headers, the X-API-Key value, query strings, request bodies or response bodies.
 */
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8080";

/** Largest request body forwarded to the API; the demo's own requests are a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;
/** How long the API may take to start answering a forwarded request. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
/** How long close() lets in-flight requests finish before it drops their connections. */
const SHUTDOWN_GRACE_MS = 2_000;

/** The only files served, by URL path. Nothing else under demo/ is reachable. */
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/api.js", { file: "api.js", type: "text/javascript; charset=utf-8" }],
  ["/helpers.js", { file: "helpers.js", type: "text/javascript; charset=utf-8" }],
]);
const PUBLIC_DIRECTORY = new URL("./public/", import.meta.url);

/** The page loads its own scripts and styles only and may call only this origin. */
const STATIC_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "no-store",
};

const HEALTH_PATHS = new Set(["/health/live", "/health/ready"]);
const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);
/** Request headers passed to the API; everything else (cookies, Authorization, Host, ...) is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "content-type", "x-api-key"]);
/** Response headers passed back to the browser. */
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-length",
  "content-type",
  "retry-after",
]);

/**
 * @typedef {object} DemoConfig
 * @property {string} host Loopback address the demo listens on.
 * @property {number} port Port the demo listens on (0 picks a free port).
 * @property {string} apiBaseUrl Origin of the API that /health/* and /v1/* are forwarded to.
 */

export class DemoConfigError extends Error {
  /** @param {readonly string[]} issues */
  constructor(issues) {
    super(`Invalid demo configuration:\n- ${issues.join("\n- ")}`);
    this.name = "DemoConfigError";
    this.issues = issues;
  }
}

/**
 * Reads DEMO_HOST, DEMO_PORT and DEMO_API_BASE_URL. Every problem is reported at once, and no
 * message repeats the configured value (an API URL could carry credentials).
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {DemoConfig}
 */
export function loadDemoConfig(env) {
  const issues = [];
  const config = {
    host: readHost(env.DEMO_HOST, issues),
    port: readPort(env.DEMO_PORT, issues),
    apiBaseUrl: readApiBaseUrl(env.DEMO_API_BASE_URL, issues),
  };
  if (issues.length > 0) {
    throw new DemoConfigError(issues);
  }
  return config;
}

function readHost(raw, issues) {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return DEFAULT_HOST;
  }
  if (!isLoopbackHost(value)) {
    issues.push(
      "DEMO_HOST must be a loopback address (127.0.0.1, ::1 or localhost): the demo is for local use only",
    );
    return DEFAULT_HOST;
  }
  return value;
}

function isLoopbackHost(value) {
  if (value === "localhost" || value === "::1") {
    return true;
  }
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

function readPort(raw, issues) {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return DEFAULT_PORT;
  }
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > 65_535) {
    issues.push("DEMO_PORT must be an integer from 0 to 65535 (0 picks a free port)");
    return DEFAULT_PORT;
  }
  return port;
}

function readApiBaseUrl(raw, issues) {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return DEFAULT_API_BASE_URL;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    issues.push("DEMO_API_BASE_URL must be a valid absolute URL");
    return DEFAULT_API_BASE_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    issues.push("DEMO_API_BASE_URL must use http or https");
  } else if (url.username !== "" || url.password !== "") {
    issues.push("DEMO_API_BASE_URL must not contain credentials");
  } else if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    issues.push(
      "DEMO_API_BASE_URL must be the API's origin only, without a path, query or fragment",
    );
  } else {
    return url.origin;
  }
  return DEFAULT_API_BASE_URL;
}

/**
 * @typedef {object} DemoServerOptions
 * @property {(line: string) => void} [log] Receives one line per forwarded request.
 * @property {number} [upstreamTimeoutMs] Overrides DEFAULT_UPSTREAM_TIMEOUT_MS (used by tests).
 */

/**
 * @typedef {object} RunningDemoServer
 * @property {string} url The address the demo listens on, for example http://127.0.0.1:3000.
 * @property {number} port
 * @property {() => Promise<void>} close Stops listening and closes connections. Idempotent.
 */

/**
 * Loads the static files, then listens. Resolves once the server accepts connections.
 *
 * @param {DemoConfig} config
 * @param {DemoServerOptions} [options]
 * @returns {Promise<RunningDemoServer>}
 */
export async function startDemoServer(config, options = {}) {
  const log = options.log ?? (() => undefined);
  const context = {
    apiOrigin: new URL(config.apiBaseUrl).origin,
    staticFiles: await loadStaticFiles(),
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    log: (line) => {
      log(sanitizeLogLine(line));
    },
  };

  const server = createServer((request, response) => {
    handleRequest(request, response, context).catch(() => {
      if (!response.headersSent) {
        sendError(
          response,
          500,
          "DEMO_INTERNAL_ERROR",
          "The demo server failed to handle the request",
        );
      } else {
        response.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  let closing;
  return {
    url: `http://${host}:${String(port)}`,
    port,
    close: () => (closing ??= closeServer(server)),
  };
}

async function loadStaticFiles() {
  const files = new Map();
  for (const [path, { file, type }] of STATIC_FILES) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed name from STATIC_FILES inside demo/public, never request input
    files.set(path, { body: await readFile(new URL(file, PUBLIC_DIRECTORY)), type });
  }
  return files;
}

function closeServer(server) {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    server.close(() => {
      clearTimeout(forceClose);
      resolve(undefined);
    });
    server.closeIdleConnections();
  });
}

async function handleRequest(request, response, context) {
  const target = parseTarget(request.url ?? "");
  if (target === undefined) {
    sendError(response, 400, "DEMO_INVALID_PATH", "The request path is not valid");
    return;
  }

  if (HEALTH_PATHS.has(target.path) || target.path.startsWith("/v1/")) {
    await forwardToApi(request, response, target, context);
    return;
  }

  const file = context.staticFiles.get(target.path);
  if (file === undefined) {
    sendError(
      response,
      404,
      "DEMO_ROUTE_NOT_ALLOWED",
      "The demo server serves its page and forwards only /health/live, /health/ready and /v1/*",
    );
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendError(response, 405, "DEMO_METHOD_NOT_ALLOWED", "Method not allowed", {
      allow: "GET, HEAD",
    });
    return;
  }
  response.writeHead(200, {
    ...STATIC_HEADERS,
    "content-type": file.type,
    "content-length": String(file.body.length),
  });
  response.end(request.method === "HEAD" ? undefined : file.body);
}

/**
 * Splits an origin-form request target into its path and raw query. Returns undefined for
 * anything that is not a plain, already-normalized path: absolute-form targets, "//", empty
 * segments, backslashes, "." and ".." segments (also percent-encoded) and encoded separators.
 * The proxy therefore never forwards a path that a URL parser or the API could rewrite.
 *
 * @param {string} rawTarget
 * @returns {{ path: string, search: string } | undefined}
 */
export function parseTarget(rawTarget) {
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
    return undefined;
  }
  const queryStart = rawTarget.indexOf("?");
  const path = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  const search = queryStart === -1 ? "" : rawTarget.slice(queryStart);
  if (path === "/") {
    return { path, search };
  }
  for (const segment of path.slice(1).split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      /[/\\#\p{Cc}]/u.test(decoded) ||
      segment.includes("\\")
    ) {
      return undefined;
    }
  }
  return { path, search };
}

async function forwardToApi(request, response, target, context) {
  const started = performance.now();
  const method = request.method ?? "";
  const finish = (status, note) => {
    const elapsed = Math.round(performance.now() - started);
    context.log(
      `${method} ${target.path} -> ${String(status)}${note === undefined ? "" : ` ${note}`} (${String(elapsed)} ms)`,
    );
  };

  if (!PROXY_METHODS.has(method)) {
    sendError(response, 405, "DEMO_METHOD_NOT_ALLOWED", "Method not allowed", {
      allow: "GET, POST, PUT, PATCH",
    });
    finish(405, "method not forwarded");
    return;
  }

  const body = await readBody(request);
  if (body === undefined) {
    sendError(response, 413, "DEMO_BODY_TOO_LARGE", "The request body is too large for the demo");
    finish(413, "body too large");
    return;
  }

  // The path was validated by parseTarget, so it cannot change the origin; checked again anyway.
  const upstreamUrl = new URL(`${target.path}${target.search}`, context.apiOrigin);
  if (upstreamUrl.origin !== context.apiOrigin) {
    sendError(response, 400, "DEMO_INVALID_PATH", "The request path is not valid");
    finish(400, "invalid path");
    return;
  }

  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name, value]) => FORWARDED_REQUEST_HEADERS.has(name) && typeof value === "string",
    ),
  );
  if (body.length > 0) {
    headers["content-length"] = String(body.length);
  }

  const send = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(upstreamUrl, { method, headers, timeout: context.upstreamTimeoutMs });

  upstream.on("response", (upstreamResponse) => {
    const status = upstreamResponse.statusCode ?? 502;
    response.writeHead(status, {
      ...Object.fromEntries(
        Object.entries(upstreamResponse.headers).filter(([name]) =>
          FORWARDED_RESPONSE_HEADERS.has(name),
        ),
      ),
      "x-content-type-options": "nosniff",
    });
    upstreamResponse.pipe(response);
    upstreamResponse.on("end", () => {
      finish(status);
    });
    upstreamResponse.on("error", () => {
      response.destroy();
    });
  });

  upstream.on("timeout", () => {
    upstream.destroy(Object.assign(new Error("upstream timeout"), { code: "DEMO_TIMEOUT" }));
  });

  let browserGone = false;
  upstream.on("error", (error) => {
    const timedOut = error.code === "DEMO_TIMEOUT";
    if (browserGone) {
      finish(499, "browser closed the connection");
      return;
    }
    if (response.headersSent) {
      response.destroy();
      finish(response.statusCode, "upstream connection lost");
      return;
    }
    if (timedOut) {
      sendError(response, 504, "DEMO_UPSTREAM_TIMEOUT", "The API did not answer in time");
      finish(504, "upstream timeout");
    } else {
      sendError(
        response,
        502,
        "DEMO_UPSTREAM_UNAVAILABLE",
        "The demo server could not reach the API. Is the backend running?",
      );
      // Only the error code (for example ECONNREFUSED): never a message, URL or header.
      finish(
        502,
        `upstream unavailable${typeof error.code === "string" ? ` (${error.code})` : ""}`,
      );
    }
  });

  // The browser went away before the API answered: do not leave the forwarded request open.
  response.on("close", () => {
    if (!response.writableFinished) {
      browserGone = true;
      upstream.destroy();
    }
  });

  upstream.end(body);
}

/** Collects the request body, or returns undefined when it exceeds MAX_BODY_BYTES. */
function readBody(request) {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > MAX_BODY_BYTES) {
    request.resume();
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks) : undefined);
    });
    request.on("error", reject);
  });
}

function sendError(response, status, code, message, extraHeaders = {}) {
  const body = JSON.stringify({ error: { code, message } });
  response.writeHead(status, {
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

/**
 * Last line of defense for log output: no control characters (no forged log lines), nothing
 * shaped like an API key, and a bounded length.
 *
 * @param {string} line
 */
export function sanitizeLogLine(line) {
  return line
    .replace(/\p{Cc}/gu, "?")
    .replace(/umqs_[A-Za-z0-9_-]{8,}/g, "umqs_[REDACTED]")
    .slice(0, 300);
}
