import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../../../src/app/build-app.js";
import type { AccountRecord } from "../../../../src/modules/accounts/accounts.repository.js";
import { hashApiKey } from "../../../../src/modules/auth/api-key.js";
import {
  readApiKeyHeader,
  requireAuthenticatedAccount,
  type ResolveAccountByApiKeyHash,
} from "../../../../src/modules/auth/authenticate.js";
import { testAppDependencies } from "../../../helpers/app-stubs.js";
import { createCapturingLogger } from "../../../helpers/logger.js";

// Synthetic keys built from fixed bytes; never keys issued by the service.
const KNOWN_KEY = `umqs_${Buffer.alloc(32, 0x11).toString("base64url")}`;
const UNKNOWN_KEY = `umqs_${Buffer.alloc(32, 0x22).toString("base64url")}`;
const ACCOUNT_ID = "6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const UNAUTHORIZED_BODY = {
  error: { code: "UNAUTHORIZED", message: "A valid API key is required" },
};

const ACCOUNT: AccountRecord = {
  id: ACCOUNT_ID,
  name: "Acme",
  createdAt: new Date("2026-10-13T10:00:00.000Z"),
  updatedAt: new Date("2026-10-13T10:00:00.000Z"),
  plan: {
    id: "a0000000-0000-4000-8000-000000000001",
    code: "starter",
    name: "Starter",
    scope: "ACCOUNT",
    monthlyAllowance: 10_000,
    maxUnitsPerRequest: 100,
  },
};

let app: App | undefined;
let resolvedDigests: string[];
let logLines: string[];

/** The real application with an in-memory key store holding KNOWN_KEY for ACCOUNT_ID. */
async function appWithKnownKey(): Promise<App> {
  resolvedDigests = [];
  const resolve: ResolveAccountByApiKeyHash = (digest) => {
    resolvedDigests.push(digest.toString("hex"));
    return Promise.resolve(digest.equals(hashApiKey(KNOWN_KEY)) ? { id: ACCOUNT_ID } : undefined);
  };
  const capture = createCapturingLogger();
  logLines = capture.lines;
  app = await buildApp(
    testAppDependencies({
      logger: capture.logger,
      accounts: {
        createAccount: () => Promise.reject(new Error("not used")),
        getAccount: (id) => Promise.resolve({ ...ACCOUNT, id }),
      },
      resolveAccountByApiKeyHash: resolve,
    }),
  );
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("readApiKeyHeader", () => {
  it("returns the single raw value, matching the header name case-insensitively", () => {
    expect(readApiKeyHeader(["Host", "example", "X-API-Key", KNOWN_KEY])).toBe(KNOWN_KEY);
    expect(readApiKeyHeader(["x-api-key", KNOWN_KEY])).toBe(KNOWN_KEY);
    expect(readApiKeyHeader(["X-API-KEY", KNOWN_KEY])).toBe(KNOWN_KEY);
  });

  it("returns the value untouched, without trimming", () => {
    expect(readApiKeyHeader(["X-API-Key", ` ${KNOWN_KEY} `])).toBe(` ${KNOWN_KEY} `);
  });

  it.each([
    ["absent", ["Host", "example", "Authorization", `Bearer ${KNOWN_KEY}`]],
    ["repeated", ["X-API-Key", KNOWN_KEY, "X-API-Key", KNOWN_KEY]],
    ["repeated with different casing", ["x-api-key", KNOWN_KEY, "X-Api-Key", UNKNOWN_KEY]],
  ])("returns undefined when the header is %s", (_label, rawHeaders) => {
    expect(readApiKeyHeader(rawHeaders)).toBeUndefined();
  });
});

describe("GET /v1/account authentication", () => {
  it("resolves the account that owns the key", async () => {
    const instance = await appWithKnownKey();

    const response = await instance.inject({
      method: "GET",
      url: "/v1/account",
      headers: { "x-api-key": KNOWN_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string }>().id).toBe(ACCOUNT_ID);
    expect(resolvedDigests).toEqual([hashApiKey(KNOWN_KEY).toString("hex")]);
  });

  it.each([
    ["a missing header", {}],
    ["an empty header", { "x-api-key": "" }],
    ["a malformed key", { "x-api-key": "umqs_short" }],
    ["a key with surrounding spaces", { "x-api-key": ` ${KNOWN_KEY}` }],
    ["a bearer token instead of X-API-Key", { authorization: `Bearer ${KNOWN_KEY}` }],
    ["two X-API-Key headers", { "x-api-key": [KNOWN_KEY, KNOWN_KEY] }],
  ])("rejects %s with the standard 401 without looking up any key", async (_label, headers) => {
    const instance = await appWithKnownKey();

    const response = await instance.inject({ method: "GET", url: "/v1/account", headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_BODY);
    expect(resolvedDigests).toEqual([]);
  });

  it("rejects a well-formed but unknown key with the same 401 after one lookup", async () => {
    const instance = await appWithKnownKey();

    const response = await instance.inject({
      method: "GET",
      url: "/v1/account",
      headers: { "x-api-key": UNKNOWN_KEY },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_BODY);
    expect(resolvedDigests).toHaveLength(1);
  });

  it("returns byte-identical 401 responses for malformed and unknown keys", async () => {
    const instance = await appWithKnownKey();
    const send = (key: string) =>
      instance.inject({ method: "GET", url: "/v1/account", headers: { "x-api-key": key } });

    const malformed = await send("not-a-key");
    const unknown = await send(UNKNOWN_KEY);

    expect(malformed.body).toBe(unknown.body);
    expect(malformed.headers["content-type"]).toBe(unknown.headers["content-type"]);
    expect(malformed.headers["content-length"]).toBe(unknown.headers["content-length"]);
  });

  it("never writes a presented key to the logs", async () => {
    const instance = await appWithKnownKey();

    await instance.inject({
      method: "GET",
      url: "/v1/account",
      headers: { "x-api-key": KNOWN_KEY },
    });
    await instance.inject({
      method: "GET",
      url: "/v1/account",
      headers: { "x-api-key": UNKNOWN_KEY },
    });

    const logs = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(logs).not.toContain(KNOWN_KEY.slice(5));
    expect(logs).not.toContain(UNKNOWN_KEY.slice(5));
  });

  it("documents the API-key security scheme in OpenAPI", async () => {
    const instance = await appWithKnownKey();

    const document = (await instance.inject({ method: "GET", url: "/docs/json" })).json<{
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown }>>;
    }>();

    expect(document.components.securitySchemes.apiKey).toEqual({
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
      description: "The account API key returned once by POST /v1/accounts",
    });
    expect(document.paths["/v1/account"]?.get?.security).toEqual([{ apiKey: [] }]);
    expect(document.paths["/v1/accounts"]?.post?.security).toBeUndefined();
  });
});

describe("requireAuthenticatedAccount", () => {
  it("refuses to run on a route without the authentication hook", async () => {
    const plain = Fastify();
    plain.decorateRequest("authenticatedAccount", null);
    plain.get("/unprotected", (request) => requireAuthenticatedAccount(request));
    try {
      const response = await plain.inject({ method: "GET", url: "/unprotected" });

      expect(response.statusCode).toBe(500);
    } finally {
      await plain.close();
    }
  });
});
