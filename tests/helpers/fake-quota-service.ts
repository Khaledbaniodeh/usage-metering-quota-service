import type { FetchFunction } from "../../client/api-client.js";
import { fakeFetch, json, sampleApiKey, type RecordedRequest } from "./fake-fetch.js";

/**
 * An in-memory model of the service's public HTTP contract, for testing the example client
 * without a service: accounts with API keys, the four predefined plans, custom plans, plan
 * assignment, the four quota rules in the documented order, byte-identical idempotent replay,
 * usage, and the paginated user, usage and history lists. It answers only what the client calls.
 *
 * `tamper` corrupts one response body (it may return a new value or edit the given one) so a test
 * can prove the client notices; `intercept`
 * replaces a response outright (for example with an error).
 */

export const FAKE_MONTH = "2026-10";

type Scope = "ACCOUNT" | "USER";

interface PlanRecord {
  id: string;
  code: string | null;
  name: string;
  scope: Scope;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  ownerApiKey: string | null;
}

export const PREDEFINED_PLANS: readonly Readonly<PlanRecord>[] = [
  ["a0000000-0000-4000-8000-000000000001", "starter", "Starter", "ACCOUNT", 10_000, 100],
  ["a0000000-0000-4000-8000-000000000002", "pro", "Pro", "ACCOUNT", 100_000, 1_000],
  ["b0000000-0000-4000-8000-000000000001", "basic", "Basic", "USER", 1_000, 20],
  ["b0000000-0000-4000-8000-000000000002", "premium", "Premium", "USER", 10_000, 100],
].map(([id, code, name, scope, monthlyAllowance, maxUnitsPerRequest]) => ({
  id: id as string,
  code: code as string,
  name: name as string,
  scope: scope as Scope,
  monthlyAllowance: monthlyAllowance as number,
  maxUnitsPerRequest: maxUnitsPerRequest as number,
  ownerApiKey: null,
}));

interface UserRecord {
  id: string;
  name: string;
  planId: string;
  used: number;
}

interface AccountRecord {
  id: string;
  name: string;
  planId: string;
  used: number;
  users: UserRecord[];
  /** Exact response text of each decision, by request ID, oldest first. */
  decisions: Map<string, { userId: string; units: number; text: string }>;
}

export interface FakeServiceOptions {
  /** Replaces the JSON body of a response; `call` is `METHOD /path` (path without query). */
  readonly tamper?: (call: string, body: unknown, request: RecordedRequest) => unknown;
  /** Answers a request instead of the model when it returns a response. */
  readonly intercept?: (request: RecordedRequest) => Response | undefined;
}

const TIMESTAMP = "2026-10-16T10:00:00.000Z";
const ACCOUNT_ID = "11111111-1111-4111-8111-11111111111";
const USER_ID = "22222222-2222-4222-8222-0000000000";
const PLAN_ID = "c0000000-0000-4000-8000-00000000000";

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

/** `cursor` = index of the next item; the real service's cursors are opaque, so is this one. */
function page<T>(items: readonly T[], url: URL): { items: T[]; nextCursor: string | null } {
  const limit = Number(url.searchParams.get("limit") ?? "20");
  const start = Number(url.searchParams.get("cursor")?.replace("at-", "") ?? "0");
  const end = start + limit;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? `at-${String(end)}` : null,
  };
}

export function fakeQuotaService(options: FakeServiceOptions = {}): {
  readonly fetch: FetchFunction;
  readonly requests: RecordedRequest[];
  /** The API key issued by the first POST /v1/accounts. */
  readonly apiKey: () => string;
} {
  const plans: PlanRecord[] = PREDEFINED_PLANS.map((plan) => ({ ...plan }));
  const accounts = new Map<string, AccountRecord>();
  let issued: string | undefined;
  let accountCount = 0;
  let userCount = 0;
  let planCount = 0;

  const planOf = (id: string): PlanRecord => {
    const plan = plans.find((candidate) => candidate.id === id);
    if (plan === undefined) {
      throw new Error(`the fake service lost plan ${id}`);
    }
    return plan;
  };
  const summary = (plan: PlanRecord) => ({
    id: plan.id,
    code: plan.code,
    name: plan.name,
    scope: plan.scope,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
  });
  const resource = (plan: PlanRecord) => ({
    ...summary(plan),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  const accountBody = (account: AccountRecord) => ({
    id: account.id,
    name: account.name,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    plan: summary(planOf(account.planId)),
  });
  const userBody = (user: UserRecord) => ({
    id: user.id,
    name: user.name,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    plan: summary(planOf(user.planId)),
  });
  const live = (plan: PlanRecord, used: number) => ({
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
    remaining: Math.max(0, plan.monthlyAllowance - used),
  });
  const visible = (apiKey: string, planId: unknown) =>
    plans.find(
      (plan) => plan.id === planId && (plan.ownerApiKey === null || plan.ownerApiKey === apiKey),
    );

  function consume(account: AccountRecord, body: Record<string, unknown>): Response {
    const { userId, units, requestId } = body as {
      userId: string;
      units: number;
      requestId: string;
    };
    const stored = account.decisions.get(requestId);
    if (stored !== undefined) {
      return stored.userId === userId && stored.units === units
        ? json(200, undefined, stored.text)
        : error(409, "IDEMPOTENCY_CONFLICT", "The requestId was already used");
    }
    const user = account.users.find((candidate) => candidate.id === userId);
    if (user === undefined) {
      return error(404, "NOT_FOUND", "User not found");
    }
    const userPlan = planOf(user.planId);
    const accountPlan = planOf(account.planId);
    // The documented order: user per-request, account per-request, user monthly, account monthly.
    const rules: [boolean, string, string][] = [
      [units > userPlan.maxUnitsPerRequest, "MAX_UNITS_PER_REQUEST", "USER"],
      [units > accountPlan.maxUnitsPerRequest, "MAX_UNITS_PER_REQUEST", "ACCOUNT"],
      [user.used + units > userPlan.monthlyAllowance, "MONTHLY_ALLOWANCE", "USER"],
      [account.used + units > accountPlan.monthlyAllowance, "MONTHLY_ALLOWANCE", "ACCOUNT"],
    ];
    const blocked = rules.find(([fails]) => fails);
    if (blocked === undefined) {
      user.used += units;
      account.used += units;
    }
    const levelOf = (plan: PlanRecord, used: number) => ({
      planId: plan.id,
      planName: plan.name,
      monthlyAllowance: plan.monthlyAllowance,
      maxUnitsPerRequest: plan.maxUnitsPerRequest,
      used,
      remaining: Math.max(0, plan.monthlyAllowance - used),
    });
    const text = JSON.stringify({
      requestId,
      userId,
      units,
      accepted: blocked === undefined,
      blockingRule: blocked?.[1] ?? null,
      blockingLevel: blocked?.[2] ?? null,
      month: FAKE_MONTH,
      processedAt: TIMESTAMP,
      account: levelOf(accountPlan, account.used),
      user: levelOf(userPlan, user.used),
    });
    account.decisions.set(requestId, { userId, units, text });
    return json(200, undefined, text);
  }

  function route(request: RecordedRequest): Response {
    const { method, url } = request;
    const path = url.pathname;
    const call = `${method} ${path}`;
    const body = (request.body === null ? {} : JSON.parse(request.body)) as Record<string, unknown>;

    if (call === "GET /health/live") return json(200, { status: "ok" });
    if (call === "GET /health/ready") return json(200, { status: "ready" });
    if (call === "POST /v1/accounts") {
      accountCount += 1;
      const apiKey = sampleApiKey();
      issued ??= apiKey;
      const account: AccountRecord = {
        id: `${ACCOUNT_ID}${String(accountCount)}`,
        name: String(body.name),
        planId: "a0000000-0000-4000-8000-000000000001",
        used: 0,
        users: [],
        decisions: new Map(),
      };
      accounts.set(apiKey, account);
      return json(201, { ...accountBody(account), apiKey });
    }

    const apiKey = request.headers["x-api-key"] ?? "";
    const account = accounts.get(apiKey);
    if (account === undefined) {
      return error(401, "UNAUTHORIZED", "A valid API key is required");
    }
    const userMatch = /^\/v1\/users\/([^/]+)(\/plan|\/usage)?$/.exec(path);
    const user = account.users.find((candidate) => candidate.id === userMatch?.[1]);
    const planMatch = /^\/v1\/plans\/([^/]+)$/.exec(path);

    if (call === "PUT /v1/account/plan") {
      const plan = visible(apiKey, body.planId);
      if (plan === undefined) return error(404, "NOT_FOUND", "Plan not found");
      if (plan.scope !== "ACCOUNT") return error(409, "PLAN_SCOPE_MISMATCH", "Wrong scope");
      account.planId = plan.id;
      return json(200, accountBody(account));
    }
    if (call === "GET /v1/plans") {
      const scope = url.searchParams.get("scope");
      const listed = plans.filter(
        (plan) =>
          (plan.ownerApiKey === null || plan.ownerApiKey === apiKey) &&
          (scope === null || plan.scope === scope),
      );
      return json(200, { plans: listed.map(resource) });
    }
    if (call === "POST /v1/plans") {
      planCount += 1;
      const plan: PlanRecord = {
        id: `${PLAN_ID}${String(planCount)}`,
        code: null,
        name: String(body.name),
        scope: body.scope as Scope,
        monthlyAllowance: Number(body.monthlyAllowance),
        maxUnitsPerRequest: Number(body.maxUnitsPerRequest),
        ownerApiKey: apiKey,
      };
      plans.push(plan);
      return json(201, resource(plan));
    }
    if (method === "PATCH" && planMatch !== null) {
      const plan = visible(apiKey, planMatch[1]);
      if (plan === undefined) return error(404, "NOT_FOUND", "Plan not found");
      if (plan.ownerApiKey === null) return error(409, "PLAN_READ_ONLY", "Read-only plan");
      Object.assign(plan, body);
      return json(200, resource(plan));
    }
    if (call === "POST /v1/users") {
      userCount += 1;
      const created: UserRecord = {
        id: `${USER_ID}${String(userCount).padStart(2, "0")}`,
        name: String(body.name),
        planId: "b0000000-0000-4000-8000-000000000001",
        used: 0,
      };
      account.users.push(created);
      return json(201, userBody(created));
    }
    if (call === "GET /v1/users") {
      const { items, nextCursor } = page(account.users, url);
      return json(200, { users: items.map(userBody), nextCursor });
    }
    if (userMatch !== null) {
      if (user === undefined) return error(404, "NOT_FOUND", "User not found");
      if (method === "GET" && userMatch[2] === undefined) return json(200, userBody(user));
      if (method === "GET" && userMatch[2] === "/usage") {
        return json(200, {
          month: FAKE_MONTH,
          used: user.used,
          ...live(planOf(user.planId), user.used),
        });
      }
      if (method === "PUT" && userMatch[2] === "/plan") {
        const plan = visible(apiKey, body.planId);
        if (plan === undefined) return error(404, "NOT_FOUND", "Plan not found");
        if (plan.scope !== "USER") return error(409, "PLAN_SCOPE_MISMATCH", "Wrong scope");
        user.planId = plan.id;
        return json(200, userBody(user));
      }
    }
    if (call === "POST /v1/consume") return consume(account, body);
    if (call === "GET /v1/usage") {
      return json(200, {
        month: FAKE_MONTH,
        used: account.used,
        ...live(planOf(account.planId), account.used),
      });
    }
    if (call === "GET /v1/usage/users") {
      const newestFirst = [...account.users].reverse().map((item) => {
        const plan = planOf(item.planId);
        return {
          userId: item.id,
          name: item.name,
          planId: plan.id,
          planName: plan.name,
          used: item.used,
          ...live(plan, item.used),
        };
      });
      const { items, nextCursor } = page(newestFirst, url);
      return json(200, { month: FAKE_MONTH, currentMonth: true, users: items, nextCursor });
    }
    if (call === "GET /v1/history") {
      const newestFirst = [...account.decisions.values()]
        .reverse()
        .map((decision) => JSON.parse(decision.text) as unknown);
      const { items, nextCursor } = page(newestFirst, url);
      return json(200, { userId: null, month: null, decisions: items, nextCursor });
    }
    throw new Error(`the fake service does not answer ${call}`);
  }

  const recorded = fakeFetch(async (request) => {
    const replaced = options.intercept?.(request);
    if (replaced !== undefined) {
      return replaced;
    }
    const response = route(request);
    if (options.tamper === undefined) {
      return response;
    }
    const text = await response.text();
    const original = JSON.parse(text) as unknown;
    const changed = JSON.stringify(
      options.tamper(`${request.method} ${request.url.pathname}`, original, request),
    );
    // Unchanged bodies keep their exact text, so byte-for-byte replays still match.
    return json(response.status, undefined, changed === text ? text : changed);
  });

  return {
    fetch: recorded.fetch,
    requests: recorded.requests,
    apiKey: () => {
      if (issued === undefined) {
        throw new Error("no account was created");
      }
      return issued;
    },
  };
}
