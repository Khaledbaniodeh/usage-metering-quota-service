import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  createTestAccount,
  resetAccountState,
  type TestAccount,
} from "../../helpers/account-harness.js";
import { createIntegrationApp, type IntegrationApp } from "../../helpers/test-app.js";
import { withTestClient } from "../../helpers/test-database.js";

/**
 * Cross-tenant coverage for the Phase 3 resources (and, at the end, Phase 5 reads): account B uses its own valid API key against
 * every endpoint, aiming at account A's custom plans and users. B must see none of A's resources,
 * get the same answer as for resources that do not exist, and change nothing of A's.
 */

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const PREMIUM_PLAN_ID = "b0000000-0000-4000-8000-000000000002";

interface Created {
  id: string;
}

let now = new Date("2026-10-13T12:00:00.000Z");
let integration: IntegrationApp;
let owner: TestAccount;
let intruder: TestAccount;
let ownerAccountPlan: Created;
let ownerUserPlan: Created;
let ownerUser: Created;
let intruderUserPlan: Created;
let intruderUser: Created;

beforeAll(async () => {
  await resetAccountState();
  integration = await createIntegrationApp({ clock: () => now });
  owner = await createTestAccount(integration.app, "Owner Account");
  intruder = await createTestAccount(integration.app, "Intruder Account");
  ownerAccountPlan = await create(owner, "/v1/plans", {
    name: "Owner Secret Team Plan",
    scope: "ACCOUNT",
    monthlyAllowance: 7_777,
    maxUnitsPerRequest: 77,
  });
  ownerUserPlan = await create(owner, "/v1/plans", {
    name: "Owner Secret Seat Plan",
    scope: "USER",
    monthlyAllowance: 6_666,
    maxUnitsPerRequest: 66,
  });
  ownerUser = await create(owner, "/v1/users", { name: "Owner Secret User" });
  intruderUserPlan = await create(intruder, "/v1/plans", {
    name: "Intruder Seat Plan",
    scope: "USER",
    monthlyAllowance: 100,
    maxUnitsPerRequest: 1,
  });
  intruderUser = await create(intruder, "/v1/users", { name: "Intruder User" });
  // The owner's resources are in use, so assignment must not make them visible either.
  await send(owner, "PUT", "/v1/account/plan", { planId: ownerAccountPlan.id }, 200);
  await send(owner, "PUT", `/v1/users/${ownerUser.id}/plan`, { planId: ownerUserPlan.id }, 200);
  now = new Date(now.getTime() + 60_000);
});

afterAll(async () => {
  await integration.close();
});

async function create(account: TestAccount, url: string, payload: object): Promise<Created> {
  const response = await authenticatedRequest(integration.app, account, {
    method: "POST",
    url,
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Created>();
}

async function send(
  account: TestAccount,
  method: "GET" | "PATCH" | "PUT",
  url: string,
  payload?: object,
  expectedStatus?: number,
) {
  const response = await authenticatedRequest(integration.app, account, {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  if (expectedStatus !== undefined) {
    expect(response.statusCode, response.body).toBe(expectedStatus);
  }
  return response;
}

/** Every stored row that belongs to the owner account, for before/after comparisons. */
async function ownerState() {
  return withTestClient(async (client) => {
    const account = await client.query("SELECT * FROM accounts WHERE id = $1", [owner.id]);
    const plans = await client.query(
      "SELECT * FROM plans WHERE owner_account_id = $1 ORDER BY id",
      [owner.id],
    );
    const users = await client.query("SELECT * FROM users WHERE account_id = $1 ORDER BY id", [
      owner.id,
    ]);
    return { account: account.rows, plans: plans.rows, users: users.rows };
  });
}

/** Whether a response body reveals any identifier or name of the owner's resources. */
function revealsOwner(body: string): boolean {
  return [
    owner.id,
    ownerAccountPlan.id,
    ownerUserPlan.id,
    ownerUser.id,
    "Owner Secret",
    "Owner Account",
  ].some((secret) => body.includes(secret));
}

describe("reads across accounts", () => {
  it.each(["", "?scope=ACCOUNT", "?scope=USER"])(
    "GET /v1/plans%s never lists another account's custom plans",
    async (query) => {
      const response = await send(intruder, "GET", `/v1/plans${query}`, undefined, 200);

      expect(revealsOwner(response.body)).toBe(false);
    },
  );

  it("GET /v1/users never lists another account's users", async () => {
    const response = await send(intruder, "GET", "/v1/users", undefined, 200);

    expect(response.json<{ users: Created[] }>().users.map((user) => user.id)).toEqual([
      intruderUser.id,
    ]);
    expect(revealsOwner(response.body)).toBe(false);
  });

  it("GET /v1/account shows only the caller's own account and plan", async () => {
    const response = await send(intruder, "GET", "/v1/account", undefined, 200);

    expect(response.json<Created>().id).toBe(intruder.id);
    expect(revealsOwner(response.body)).toBe(false);
  });
});

describe("requests aimed at another account's resources", () => {
  /** The owner's resources, or IDs that exist nowhere, in the same request shape. */
  interface Targets {
    user: string;
    userPlan: string;
    accountPlan: string;
  }
  type Request = [method: "GET" | "PATCH" | "PUT", url: string, payload?: object];

  const cases: [string, (targets: Targets) => Request][] = [
    ["reading its user", (t) => ["GET", `/v1/users/${t.user}`]],
    ["renaming its custom plan", (t) => ["PATCH", `/v1/plans/${t.userPlan}`, { name: "x" }]],
    [
      "changing its custom plan's limits",
      (t) => ["PATCH", `/v1/plans/${t.accountPlan}`, { monthlyAllowance: 1 }],
    ],
    [
      "switching its user to a predefined plan",
      (t) => ["PUT", `/v1/users/${t.user}/plan`, { planId: PREMIUM_PLAN_ID }],
    ],
    [
      "switching its user to the caller's plan",
      (t) => ["PUT", `/v1/users/${t.user}/plan`, { planId: intruderUserPlan.id }],
    ],
    [
      "switching its user to its own plan",
      (t) => ["PUT", `/v1/users/${t.user}/plan`, { planId: t.userPlan }],
    ],
    [
      "assigning its custom ACCOUNT plan to the caller's account",
      (t) => ["PUT", "/v1/account/plan", { planId: t.accountPlan }],
    ],
    [
      "assigning its custom USER plan to the caller's user",
      (t) => ["PUT", `/v1/users/${intruderUser.id}/plan`, { planId: t.userPlan }],
    ],
  ];

  it.each(cases)(
    "%s is answered like a missing resource and changes nothing",
    async (_label, request) => {
      const before = await ownerState();
      const intruderBefore = await send(intruder, "GET", "/v1/users", undefined, 200);

      const foreign = await send(
        intruder,
        ...request({
          user: ownerUser.id,
          userPlan: ownerUserPlan.id,
          accountPlan: ownerAccountPlan.id,
        }),
      );
      const missing = await send(
        intruder,
        ...request({ user: UNKNOWN_ID, userPlan: UNKNOWN_ID, accountPlan: UNKNOWN_ID }),
      );

      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(revealsOwner(foreign.body)).toBe(false);
      expect(await ownerState()).toEqual(before);
      expect((await send(intruder, "GET", "/v1/users", undefined, 200)).body).toBe(
        intruderBefore.body,
      );
    },
  );
});

describe("the owner's own view is unaffected", () => {
  it("still sees its custom plans, its user and their assignments", async () => {
    const plans = await send(owner, "GET", "/v1/plans", undefined, 200);
    const user = await send(owner, "GET", `/v1/users/${ownerUser.id}`, undefined, 200);
    const account = await send(owner, "GET", "/v1/account", undefined, 200);

    expect(plans.json<{ plans: Created[] }>().plans.map((plan) => plan.id)).toEqual(
      expect.arrayContaining([ownerAccountPlan.id, ownerUserPlan.id]),
    );
    expect(plans.body).not.toContain(intruderUserPlan.id);
    expect(user.json<{ plan: Created }>().plan.id).toBe(ownerUserPlan.id);
    expect(account.json<{ plan: Created }>().plan.id).toBe(ownerAccountPlan.id);
  });

  it("sees changes to its custom plans reflected in the assigned user and the account", async () => {
    await send(owner, "PATCH", `/v1/plans/${ownerUserPlan.id}`, { maxUnitsPerRequest: 65 }, 200);
    await send(owner, "PATCH", `/v1/plans/${ownerAccountPlan.id}`, { maxUnitsPerRequest: 55 }, 200);

    const user = await send(owner, "GET", `/v1/users/${ownerUser.id}`, undefined, 200);
    const account = await send(owner, "GET", "/v1/account", undefined, 200);

    expect(user.json<{ plan: { maxUnitsPerRequest: number } }>().plan.maxUnitsPerRequest).toBe(65);
    expect(account.json<{ plan: { maxUnitsPerRequest: number } }>().plan.maxUnitsPerRequest).toBe(
      55,
    );
  });
});

describe("usage, history and pagination across accounts", () => {
  const INVALID_CURSOR = '{"error":{"code":"VALIDATION_ERROR","message":"Invalid cursor"}}';
  let ownerDecisionId: string;

  beforeAll(async () => {
    // A second owner user, so the owner's user lists have a next page.
    await create(owner, "/v1/users", { name: "Owner Secret Second User" });
    for (const [account, userId, requestId] of [
      [owner, ownerUser.id, "owner-1"],
      [owner, ownerUser.id, "owner-2"],
      [intruder, intruderUser.id, "intruder-1"],
    ] as const) {
      const response = await authenticatedRequest(integration.app, account, {
        method: "POST",
        url: "/v1/consume",
        payload: { userId, units: 5, requestId },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    ownerDecisionId = await withTestClient(async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id FROM consume_decisions WHERE account_id = $1 ORDER BY seq LIMIT 1",
        [owner.id],
      );
      return result.rows[0]?.id ?? "";
    });
  });

  it.each([
    "/v1/usage",
    "/v1/usage?month=2026-10",
    "/v1/usage/users",
    "/v1/users",
    "/v1/history",
    "/v1/history?month=2026-10",
  ])("GET %s shows the caller only its own data", async (url) => {
    const response = await send(intruder, "GET", url, undefined, 200);

    expect(revealsOwner(response.body)).toBe(false);
    expect(response.body).not.toContain("owner-");
  });

  it("counts only the caller's own consumption", async () => {
    const usage = await send(intruder, "GET", "/v1/usage", undefined, 200);

    expect(usage.json<{ used: number }>().used).toBe(5);
  });

  it.each([
    ["user usage", (id: string) => `/v1/users/${id}/usage`],
    ["the history user filter", (id: string) => `/v1/history?userId=${id}`],
  ])("answers another account's user in %s exactly like an unknown user", async (_label, url) => {
    const foreign = await send(intruder, "GET", url(ownerUser.id));
    const missing = await send(intruder, "GET", url(UNKNOWN_ID));

    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
  });

  it.each(["/v1/users", "/v1/usage/users", "/v1/history"])(
    "refuses the owner's own %s cursor when the intruder presents it",
    async (path) => {
      const ownerPage = await send(owner, "GET", `${path}?limit=1`, undefined, 200);
      const cursor = ownerPage.json<{ nextCursor: string | null }>().nextCursor;
      expect(cursor).not.toBeNull();

      const stolen = await send(intruder, "GET", `${path}?cursor=${String(cursor)}`);

      expect(stolen.statusCode).toBe(400);
      expect(stolen.body).toBe(INVALID_CURSOR);
    },
  );

  it("refuses constructed cursors anchored on the owner's rows", async () => {
    const encode = (json: object) => Buffer.from(JSON.stringify(json)).toString("base64url");
    const attempts = [
      ["/v1/users", encode({ v: 1, k: "users", a: ownerUser.id })],
      [
        "/v1/usage/users",
        encode({ v: 1, k: "usage-users", a: ownerUser.id, m: "2026-10", c: true }),
      ],
      ["/v1/history", encode({ v: 1, k: "history", a: ownerDecisionId, u: null, m: null })],
    ] as const;

    for (const [path, cursor] of attempts) {
      const response = await send(intruder, "GET", `${path}?cursor=${cursor}`);
      expect(response.statusCode, path).toBe(400);
      expect(response.body).toBe(INVALID_CURSOR);
    }
  });

  it("issues cursors that carry a row UUID and never a sequence number", async () => {
    for (const path of ["/v1/users", "/v1/usage/users", "/v1/history"]) {
      const page = await send(owner, "GET", `${path}?limit=1`, undefined, 200);
      const cursor = page.json<{ nextCursor: string }>().nextCursor;
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;

      expect(Object.keys(decoded).slice(0, 3)).toEqual(["v", "k", "a"]);
      expect(decoded.a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const numbers = Object.entries(decoded).filter(([, value]) => typeof value === "number");
      expect(numbers).toEqual([["v", 1]]);
      expect(cursor).not.toMatch(/seq/i);
    }
  });
});
