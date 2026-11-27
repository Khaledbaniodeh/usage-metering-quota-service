import { Buffer } from "node:buffer";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  Agent,
  createServer,
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  demoFile,
  loadServerModule,
  randomApiKey,
  type RunningDemoServer,
} from "./demo-modules.js";

const demo = await loadServerModule();

interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type Responder = (received: ReceivedRequest, response: ServerResponse) => void;

interface Upstream {
  readonly url: string;
  readonly received: ReceivedRequest[];
  respond(responder: Responder): void;
  close(): Promise<void>;
}

function json(
  response: ServerResponse,
  status: number,
  body: string,
  headers: OutgoingHttpHeaders = {},
) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(body);
}

/** A stand-in for the API: records every request that reaches it and answers as told. */
async function startUpstream(): Promise<Upstream> {
  const received: ReceivedRequest[] = [];
  let responder: Responder = (_received, response) => {
    json(response, 200, '{"status":"ok"}');
  };
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const entry = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      responder(entry, response);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    respond: (next) => {
      responder = next;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A loopback port that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RawRequest {
  readonly method?: string;
  readonly path: string;
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: string | readonly string[];
  readonly agent?: Agent;
}

/** Sends the request target exactly as given (no URL normalization, unlike fetch). */
function send(baseUrl: string, raw: RawRequest): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        method: raw.method ?? "GET",
        path: raw.path,
        headers: raw.headers,
        agent: raw.agent ?? false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    if (Array.isArray(raw.body)) {
      for (const chunk of raw.body) {
        outgoing.write(chunk);
      }
      outgoing.end();
    } else {
      outgoing.end(raw.body);
    }
  });
}

function errorCode(response: RawResponse): unknown {
  return (JSON.parse(response.body) as { error?: { code?: unknown } }).error?.code;
}

describe("demo server", () => {
  let upstream: Upstream;
  let server: RunningDemoServer;
  let logs: string[];

  beforeEach(async () => {
    upstream = await startUpstream();
    logs = [];
    server = await demo.startDemoServer(
      { host: "127.0.0.1", port: 0, apiBaseUrl: upstream.url },
      { log: (line) => logs.push(line) },
    );
  });

  afterEach(async () => {
    await server.close();
    await upstream.close();
  });

  describe("static page", () => {
    it.each([
      ["/", "public/index.html", "text/html; charset=utf-8"],
      ["/styles.css", "public/styles.css", "text/css; charset=utf-8"],
      ["/app.js", "public/app.js", "text/javascript; charset=utf-8"],
      ["/api.js", "public/api.js", "text/javascript; charset=utf-8"],
      ["/helpers.js", "public/helpers.js", "text/javascript; charset=utf-8"],
    ])(
      "serves %s from demo/%s with its content type and security headers",
      async (path, file, type) => {
        const response = await send(server.url, { path });

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe(type);
        expect(response.body).toBe(await readFile(demoFile(file), "utf8"));
        expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
        expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
        expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(upstream.received).toHaveLength(0);
      },
    );

    it("answers HEAD without a body and refuses other methods on the page", async () => {
      const head = await send(server.url, { method: "HEAD", path: "/" });
      const post = await send(server.url, { method: "POST", path: "/", body: "{}" });

      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(post.status).toBe(405);
      expect(post.headers.allow).toBe("GET, HEAD");
      expect(errorCode(post)).toBe("DEMO_METHOD_NOT_ALLOWED");
      expect(upstream.received).toHaveLength(0);
    });
  });

  describe("forwarding to the API", () => {
    it("forwards both health checks and returns their status, body and cache header", async () => {
      upstream.respond((received, response) => {
        if (received.url === "/health/live") {
          json(response, 200, '{"status":"ok"}', { "cache-control": "no-store" });
        } else {
          json(
            response,
            503,
            '{"error":{"code":"SERVICE_UNAVAILABLE","message":"The database is not reachable"}}',
            { "cache-control": "no-store" },
          );
        }
      });

      const live = await send(server.url, { path: "/health/live" });
      const ready = await send(server.url, { path: "/health/ready" });

      expect(upstream.received.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET /health/live",
        "GET /health/ready",
      ]);
      expect(live.status).toBe(200);
      expect(live.body).toBe('{"status":"ok"}');
      expect(live.headers["cache-control"]).toBe("no-store");
      expect(ready.status).toBe(503);
      expect(errorCode(ready)).toBe("SERVICE_UNAVAILABLE");
      expect(ready.headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("forwards the path and query string exactly as sent", async () => {
      const target =
        "/v1/history?userId=0b0e5d2a-6c43-4c55-9d4e-1f0f8c1a2b3c&month=2026-10&limit=5&cursor=eyJ2IjoxfQ";
      await send(server.url, { path: target });
      await send(server.url, { path: "/v1/usage/users?month=2026-09&limit=2&extra=a%20b" });

      expect(upstream.received.map((received) => received.url)).toEqual([
        target,
        "/v1/usage/users?month=2026-09&limit=2&extra=a%20b",
      ]);
    });

    it.each(["POST", "PUT", "PATCH"])(
      "forwards a %s request with its JSON body and content type unchanged",
      async (method) => {
        const body = '{"userId":"u-1", "units":10,"requestId":"demo-1"}';
        upstream.respond((_received, response) => {
          json(response, 200, '{"requestId":"demo-1","accepted":true}');
        });

        const response = await send(server.url, {
          method,
          path: "/v1/consume",
          headers: { "content-type": "application/json" },
          body,
        });

        expect(upstream.received).toHaveLength(1);
        expect(upstream.received[0]).toMatchObject({ method, url: "/v1/consume", body });
        expect(upstream.received[0]?.headers["content-type"]).toBe("application/json");
        expect(upstream.received[0]?.headers["content-length"]).toBe(
          String(Buffer.byteLength(body)),
        );
        expect(response.status).toBe(200);
        expect(response.body).toBe('{"requestId":"demo-1","accepted":true}');
      },
    );

    it.each([
      [201, '{"id":"p-1"}'],
      [400, '{"error":{"code":"VALIDATION_ERROR","message":"body/units must be integer"}}'],
      [401, '{"error":{"code":"UNAUTHORIZED","message":"A valid API key is required"}}'],
      [404, '{"error":{"code":"NOT_FOUND","message":"User not found"}}'],
      [
        409,
        '{"error":{"code":"IDEMPOTENCY_CONFLICT","message":"The request ID was already used"}}',
      ],
      [500, '{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}'],
    ])("returns the API's %i status and body byte for byte", async (status, body) => {
      upstream.respond((_received, response) => {
        json(response, status, body);
      });

      const response = await send(server.url, { path: "/v1/users" });

      expect(response.status).toBe(status);
      expect(response.body).toBe(body);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    });

    it("passes Retry-After back and drops every other response header", async () => {
      upstream.respond((_received, response) => {
        json(response, 503, '{"error":{"code":"BUSY_RETRY","message":"busy"}}', {
          "retry-after": "1",
          "cache-control": "no-store",
          "set-cookie": "session=abc",
          "x-powered-by": "test",
          "access-control-allow-origin": "*",
          server: "upstream",
        });
      });

      const response = await send(server.url, { method: "POST", path: "/v1/consume", body: "{}" });

      expect(response.status).toBe(503);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["x-powered-by"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers.server).toBeUndefined();
    });

    it("forwards X-API-Key unchanged to the configured API and drops cookies, credentials and Host", async () => {
      const apiKey = randomApiKey();

      await send(server.url, {
        path: "/v1/account",
        headers: {
          "x-api-key": apiKey,
          cookie: "session=1",
          authorization: "Bearer other-token",
          "x-forwarded-for": "203.0.113.7",
          origin: "http://evil.example",
          referer: "http://evil.example/page",
          host: "evil.example",
          accept: "application/json",
        },
      });

      expect(upstream.received).toHaveLength(1);
      const headers: IncomingHttpHeaders = upstream.received[0]?.headers ?? {};
      expect(headers["x-api-key"]).toBe(apiKey);
      expect(headers.accept).toBe("application/json");
      expect(headers.host).toBe(new URL(upstream.url).host);
      for (const dropped of ["cookie", "authorization", "x-forwarded-for", "origin", "referer"]) {
        expect(headers).not.toHaveProperty(dropped);
      }
    });
  });

  describe("logging", () => {
    it("logs method, path and status only: never the key, headers, query or body", async () => {
      const apiKey = randomApiKey();
      upstream.respond((_received, response) => {
        json(response, 200, `{"echo":"${apiKey}"}`);
      });

      await send(server.url, {
        path: "/v1/history?cursor=secret-cursor-value&limit=5",
        headers: { "x-api-key": apiKey },
      });
      await send(server.url, {
        method: "POST",
        path: "/v1/consume",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: `{"requestId":"body-marker-value","note":"${apiKey}"}`,
      });
      await send(server.url, { path: `/v1/users/${apiKey}`, headers: { "x-api-key": apiKey } });

      const output = logs.join("\n");
      expect(logs).toHaveLength(3);
      expect(logs[0]).toMatch(/^GET \/v1\/history -> 200 \(\d+ ms\)$/);
      expect(logs[1]).toMatch(/^POST \/v1\/consume -> 200 \(\d+ ms\)$/);
      expect(logs[2]).toMatch(/^GET \/v1\/users\/umqs_\[REDACTED\] -> 200 \(\d+ ms\)$/);
      expect(output).not.toContain(apiKey);
      expect(output).not.toContain(apiKey.slice(5));
      expect(output.toLowerCase()).not.toContain("x-api-key");
      expect(output).not.toContain("secret-cursor-value");
      expect(output).not.toContain("body-marker-value");
    });

    it("removes control characters and key-shaped text from any log line", () => {
      const apiKey = randomApiKey();

      const line = demo.sanitizeLogLine(`GET /v1/x\n${apiKey}\u0007 -> 200`);

      expect(line).not.toContain(apiKey);
      expect(line).not.toMatch(/\p{Cc}/u);
      expect(line).toBe("GET /v1/x?umqs_[REDACTED]? -> 200");
      expect(demo.sanitizeLogLine("x".repeat(1_000))).toHaveLength(300);
    });
  });

  describe("refusals", () => {
    it.each([
      "/docs",
      "/docs/json",
      "/v2/accounts",
      "/v1",
      "/health",
      "/health/other",
      "/index.html",
      "/package.json",
      "/.env",
      "/server.js",
      "/main.js",
      "/demo/server.js",
      "/public/app.js",
    ])("refuses %s without contacting the API", async (path) => {
      const response = await send(server.url, { path });

      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe("DEMO_ROUTE_NOT_ALLOWED");
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(upstream.received).toHaveLength(0);
    });

    it.each(["DELETE", "OPTIONS", "HEAD"])("does not forward %s requests", async (method) => {
      const response = await send(server.url, { method, path: "/v1/account" });

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("GET, POST, PUT, PATCH");
      expect(upstream.received).toHaveLength(0);
    });

    it.each([
      "/../package.json",
      "/..%2fpackage.json",
      "/%2e%2e/package.json",
      "/%2E%2E/%2E%2E/.env",
      "/v1/../docs",
      "/v1/%2e%2e/docs",
      "/v1/..%2f..%2fpackage.json",
      "/v1/users/..%5c..%5cpackage.json",
      "/v1/users/..\\..\\package.json",
      "/v1/./account",
      "/v1//account",
      "/v1/users/%00",
      "/v1/users/%zz",
      "//evil.example/v1/account",
      "http://evil.example/v1/account",
    ])("refuses the rewritable or traversing target %s", async (path) => {
      const packageJson = await readFile(new URL("../../../package.json", import.meta.url), "utf8");

      const response = await send(server.url, { path });

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe("DEMO_INVALID_PATH");
      expect(response.body).not.toContain(packageJson.slice(0, 40));
      expect(upstream.received).toHaveLength(0);
    });

    it.each([
      ["with a declared length", undefined],
      ["sent in chunks", ["{", "x".repeat(40 * 1024), "x".repeat(40 * 1024), "}"]],
    ])("refuses a request body above the limit %s", async (_label, chunks) => {
      const tooLarge = `{"name":"${"x".repeat(demo.MAX_BODY_BYTES)}"}`;

      const response = await send(server.url, {
        method: "POST",
        path: "/v1/users",
        headers: chunks === undefined ? {} : { "transfer-encoding": "chunked" },
        body: chunks ?? tooLarge,
      });

      expect(response.status).toBe(413);
      expect(errorCode(response)).toBe("DEMO_BODY_TOO_LARGE");
      expect(upstream.received).toHaveLength(0);
    });
  });
});

describe("demo server without a reachable API", () => {
  it("answers a sanitized 502 that reveals neither the key nor connection details", async () => {
    const apiKey = randomApiKey();
    const logs: string[] = [];
    const port = await closedPort();
    const server = await demo.startDemoServer(
      { host: "127.0.0.1", port: 0, apiBaseUrl: `http://127.0.0.1:${String(port)}` },
      { log: (line) => logs.push(line) },
    );
    try {
      const response = await send(server.url, {
        method: "POST",
        path: "/v1/consume",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"units":1}',
      });

      expect(response.status).toBe(502);
      expect(JSON.parse(response.body)).toEqual({
        error: {
          code: "DEMO_UPSTREAM_UNAVAILABLE",
          message: "The demo server could not reach the API. Is the backend running?",
        },
      });
      expect(response.body).not.toContain(apiKey);
      expect(response.body).not.toContain(String(port));
      expect(response.body).not.toContain("ECONNREFUSED");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(
        /^POST \/v1\/consume -> 502 upstream unavailable \(ECONNREFUSED\) \(\d+ ms\)$/,
      );
      expect(logs.join("\n")).not.toContain(apiKey);
    } finally {
      await server.close();
    }
  });

  it("answers 504 when the API does not start answering in time", async () => {
    const upstream = await startUpstream();
    upstream.respond(() => {
      // Never answers.
    });
    const server = await demo.startDemoServer(
      { host: "127.0.0.1", port: 0, apiBaseUrl: upstream.url },
      { upstreamTimeoutMs: 200 },
    );
    try {
      const response = await send(server.url, { path: "/health/ready" });

      expect(response.status).toBe(504);
      expect(errorCode(response)).toBe("DEMO_UPSTREAM_TIMEOUT");
    } finally {
      await server.close();
      await upstream.close();
    }
  });
});

describe("demo server lifecycle", () => {
  it("starts on loopback, reports its address and shuts down cleanly with an idle keep-alive connection", async () => {
    const server = await demo.startDemoServer({
      host: "127.0.0.1",
      port: 0,
      apiBaseUrl: "http://127.0.0.1:8080",
    });
    const agent = new Agent({ keepAlive: true });
    try {
      expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}`);
      expect(server.port).toBeGreaterThan(0);
      expect((await send(server.url, { path: "/", agent })).status).toBe(200);

      const started = Date.now();
      await Promise.all([server.close(), server.close()]);

      expect(Date.now() - started).toBeLessThan(1_500);
      await expect(send(server.url, { path: "/" })).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    } finally {
      agent.destroy();
    }
  });

  it("fails to start when its port is already in use", async () => {
    const first = await demo.startDemoServer({
      host: "127.0.0.1",
      port: 0,
      apiBaseUrl: "http://127.0.0.1:8080",
    });
    try {
      await expect(
        demo.startDemoServer({
          host: "127.0.0.1",
          port: first.port,
          apiBaseUrl: "http://127.0.0.1:8080",
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});

describe("demo configuration", () => {
  it("defaults to 127.0.0.1:3000 and the local API", () => {
    expect(demo.loadDemoConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      apiBaseUrl: "http://127.0.0.1:8080",
    });
    expect(demo.loadDemoConfig({ DEMO_HOST: " ", DEMO_PORT: "", DEMO_API_BASE_URL: "" })).toEqual(
      demo.loadDemoConfig({}),
    );
  });

  it.each([
    [{ DEMO_HOST: "localhost" }, { host: "localhost" }],
    [{ DEMO_HOST: "::1" }, { host: "::1" }],
    [{ DEMO_HOST: "127.0.0.2" }, { host: "127.0.0.2" }],
    [{ DEMO_PORT: "4000" }, { port: 4000 }],
    [{ DEMO_PORT: "0" }, { port: 0 }],
    [{ DEMO_API_BASE_URL: "http://127.0.0.1:18080/" }, { apiBaseUrl: "http://127.0.0.1:18080" }],
    [{ DEMO_API_BASE_URL: "https://api.example.test" }, { apiBaseUrl: "https://api.example.test" }],
  ])("accepts %j", (env, expected) => {
    expect(demo.loadDemoConfig(env)).toMatchObject(expected);
  });

  it.each([
    [{ DEMO_HOST: "0.0.0.0" }, "DEMO_HOST must be a loopback address"],
    [{ DEMO_HOST: "192.168.1.10" }, "DEMO_HOST must be a loopback address"],
    [{ DEMO_HOST: "example.com" }, "DEMO_HOST must be a loopback address"],
    [{ DEMO_HOST: "127.0.0.256" }, "DEMO_HOST must be a loopback address"],
    [{ DEMO_PORT: "-1" }, "DEMO_PORT must be an integer from 0 to 65535"],
    [{ DEMO_PORT: "65536" }, "DEMO_PORT must be an integer from 0 to 65535"],
    [{ DEMO_PORT: "80.5" }, "DEMO_PORT must be an integer from 0 to 65535"],
    [{ DEMO_PORT: "http" }, "DEMO_PORT must be an integer from 0 to 65535"],
    [{ DEMO_API_BASE_URL: "not a url" }, "DEMO_API_BASE_URL must be a valid absolute URL"],
    [{ DEMO_API_BASE_URL: "ftp://127.0.0.1" }, "DEMO_API_BASE_URL must use http or https"],
    [{ DEMO_API_BASE_URL: "http://127.0.0.1:8080/api" }, "without a path, query or fragment"],
    [{ DEMO_API_BASE_URL: "http://127.0.0.1:8080?x=1" }, "without a path, query or fragment"],
    [{ DEMO_API_BASE_URL: "http://127.0.0.1:8080#top" }, "without a path, query or fragment"],
  ])("rejects %j", (env, message) => {
    expect(() => demo.loadDemoConfig(env)).toThrow(message);
  });

  it("reports every problem at once without repeating the configured values", () => {
    const env = {
      DEMO_HOST: "192.168.1.10",
      DEMO_PORT: "99999",
      DEMO_API_BASE_URL: "http://demo-user:pa55word-marker@127.0.0.1:8080",
    };

    let error: unknown;
    try {
      demo.loadDemoConfig(env);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(demo.DemoConfigError);
    const { issues, message } = error as InstanceType<typeof demo.DemoConfigError>;
    expect(issues).toEqual([
      expect.stringContaining("DEMO_HOST must be a loopback address") as unknown,
      expect.stringContaining("DEMO_PORT must be an integer") as unknown,
      "DEMO_API_BASE_URL must not contain credentials",
    ]);
    for (const value of ["192.168.1.10", "99999", "pa55word-marker", "demo-user"]) {
      expect(message).not.toContain(value);
    }
  });
});

describe("request target parsing", () => {
  it.each([
    ["/", { path: "/", search: "" }],
    ["/v1/users?limit=5", { path: "/v1/users", search: "?limit=5" }],
    ["/v1/users/a%20b", { path: "/v1/users/a%20b", search: "" }],
    ["/v1/history?cursor=a/b", { path: "/v1/history", search: "?cursor=a/b" }],
  ])("splits %s into its path and query", (target, expected) => {
    expect(demo.parseTarget(target)).toEqual(expected);
  });
});
