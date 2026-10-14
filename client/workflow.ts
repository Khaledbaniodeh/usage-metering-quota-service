import { isDeepStrictEqual } from "node:util";
import type { ConsumeResult, PublicApi } from "./api-client.js";
import type { Decision, MonthlyUsage, Plan, User } from "./api-types.js";
import { collectAllPages } from "./pagination.js";

/**
 * The example workflow: one realistic pass through the public API that checks every outcome it
 * depends on. Expectations are derived from earlier responses (plan limits, IDs, the decisions'
 * month), never from the clock or hard-coded dates.
 */

export const USER_COUNT = 3;
/** Small enough that every list needs one page per item. */
export const PAGE_LIMIT = 1;
const FIRST_UNITS = 5;
const SECOND_UNITS = 7;

export interface WorkflowOptions {
  /** Makes names and request IDs unique per run, so runs never collide. */
  readonly runId: string;
  /** Receives one safe progress line per completed step. */
  readonly log: (line: string) => void;
}

export interface WorkflowSummary {
  readonly accountId: string;
  readonly month: string;
  readonly users: number;
  readonly acceptedDecisions: number;
  readonly rejectedDecisions: number;
  readonly unitsUsed: number;
  readonly pages: { readonly users: number; readonly usage: number; readonly history: number };
}

/** A failed step: which step, and a message with safe values only (IDs, counts, codes). */
export class WorkflowFailure extends Error {
  override readonly name = "WorkflowFailure";

  constructor(
    readonly step: string,
    message: string,
    /** The client error behind the failure, if any (kept for its kind; never printed whole). */
    readonly reason?: unknown,
  ) {
    super(message);
  }
}

class CheckFailed extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new CheckFailed(message);
  }
}

/** A value for a failure message, shortened so messages stay concise. */
function brief(value: unknown): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function checkEqual(actual: unknown, expected: unknown, what: string): void {
  check(
    isDeepStrictEqual(actual, expected),
    `${what}: expected ${brief(expected)}, got ${brief(actual)}`,
  );
}

/** Runs one named step, turning any failure into a WorkflowFailure that names the step. */
async function step<T>(name: string, log: (line: string) => void, run: () => Promise<[T, string]>) {
  let outcome: [T, string];
  try {
    outcome = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected failure";
    throw new WorkflowFailure(name, message, error);
  }
  log(`[ok] ${name}: ${outcome[1]}`);
  return outcome[0];
}

/** The retry must return exactly the original response, byte for byte. */
export function replayMismatch(original: ConsumeResult, replay: ConsumeResult): string | undefined {
  if (replay.rawBody === original.rawBody) {
    return undefined;
  }
  return `the retry returned a different response (${String(replay.rawBody.length)} bytes, original ${String(original.rawBody.length)} bytes)`;
}

/** Checks a usage response against the expected count and, for the current month, the plan. */
function checkUsage(usage: MonthlyUsage, month: string, used: number, plan: Plan, what: string) {
  checkEqual(usage.month, month, `${what} month`);
  checkEqual(usage.used, used, `${what} used`);
  if (usage.monthlyAllowance !== undefined) {
    checkEqual(usage.monthlyAllowance, plan.monthlyAllowance, `${what} monthlyAllowance`);
    checkEqual(usage.maxUnitsPerRequest, plan.maxUnitsPerRequest, `${what} maxUnitsPerRequest`);
    checkEqual(usage.remaining, Math.max(0, plan.monthlyAllowance - used), `${what} remaining`);
  }
}

function checkAccepted(
  decision: Decision,
  userId: string,
  units: number,
  used: number,
  total: number,
) {
  checkEqual(
    [decision.accepted, decision.blockingRule, decision.blockingLevel],
    [true, null, null],
    `decision ${decision.requestId} outcome`,
  );
  checkEqual(
    [decision.userId, decision.units],
    [userId, units],
    `decision ${decision.requestId} request`,
  );
  checkEqual(decision.user.used, used, `decision ${decision.requestId} user used`);
  checkEqual(decision.account.used, total, `decision ${decision.requestId} account used`);
}

export async function runExampleWorkflow(
  api: PublicApi,
  { runId, log }: WorkflowOptions,
): Promise<WorkflowSummary> {
  await step("health", log, async () => {
    checkEqual((await api.live()).status, "ok", "GET /health/live status");
    checkEqual((await api.ready()).status, "ready", "GET /health/ready status");
    return [undefined, "live and ready"];
  });

  // The key exists only inside `account` (wrapped) and is never logged.
  const { accountId, accountPlan, account } = await step("create account", log, async () => {
    const created = await api.createAccount(`Example client ${runId}`);
    checkEqual(created.account.plan.scope, "ACCOUNT", "new account plan scope");
    const result = {
      accountId: created.account.id,
      accountPlan: created.account.plan,
      account: api.forAccount(created.apiKey),
    };
    return [result, `${created.account.id} on plan ${created.account.plan.name}`];
  });

  const users = await step("create users", log, async () => {
    const created: User[] = [];
    for (let index = 1; index <= USER_COUNT; index += 1) {
      const user = await account.createUser(`Example user ${String(index)}`);
      checkEqual(user.plan.scope, "USER", `user ${user.id} plan scope`);
      created.push(user);
    }
    return [created, `${String(created.length)} users`];
  });
  const [first, second] = users;
  check(first !== undefined && second !== undefined, "two users were created");
  const userPlan = first.plan;
  check(
    SECOND_UNITS <= Math.min(userPlan.maxUnitsPerRequest, accountPlan.maxUnitsPerRequest),
    "the default plans allow the example's accepted requests",
  );

  const accepted = await step("accepted request", log, async () => {
    const result = await account.consume({
      userId: first.id,
      units: FIRST_UNITS,
      requestId: `${runId}-accepted-1`,
    });
    checkAccepted(result.decision, first.id, FIRST_UNITS, FIRST_UNITS, FIRST_UNITS);
    return [result, `${String(FIRST_UNITS)} units accepted for user 1`];
  });

  await step("idempotent retry", log, async () => {
    const replay = await account.consume({
      userId: first.id,
      units: FIRST_UNITS,
      requestId: `${runId}-accepted-1`,
    });
    const mismatch = replayMismatch(accepted, replay);
    check(mismatch === undefined, mismatch ?? "");
    return [undefined, `identical response (${String(replay.rawBody.length)} bytes)`];
  });

  const unitsUsed = FIRST_UNITS + SECOND_UNITS;
  const secondAccepted = await step("second accepted request", log, async () => {
    const result = await account.consume({
      userId: second.id,
      units: SECOND_UNITS,
      requestId: `${runId}-accepted-2`,
    });
    checkAccepted(result.decision, second.id, SECOND_UNITS, SECOND_UNITS, unitsUsed);
    return [result, `${String(SECOND_UNITS)} units accepted for user 2`];
  });

  // The user's per-request limit is the first rule checked, so one unit more is always blocked there.
  const rejectedUnits = userPlan.maxUnitsPerRequest + 1;
  const rejected = await step("quota rejection", log, async () => {
    const result = await account.consume({
      userId: first.id,
      units: rejectedUnits,
      requestId: `${runId}-rejected-1`,
    });
    const { decision } = result;
    checkEqual(
      [decision.accepted, decision.blockingRule, decision.blockingLevel],
      [false, "MAX_UNITS_PER_REQUEST", "USER"],
      "rejection outcome",
    );
    checkEqual(decision.user.used, FIRST_UNITS, "user used after the rejection");
    checkEqual(decision.account.used, unitsUsed, "account used after the rejection");
    return [result, `${String(rejectedUnits)} units blocked by USER MAX_UNITS_PER_REQUEST`];
  });

  const decisions = [accepted.decision, secondAccepted.decision, rejected.decision];
  const month = accepted.decision.month;
  if (decisions.some((decision) => decision.month !== month)) {
    throw new WorkflowFailure(
      "quota rejection",
      "the UTC month changed during the run; run the example again",
    );
  }
  // Accepted units per user; the rejected request counted nothing.
  const expectedUsed = new Map([
    [first.id, FIRST_UNITS],
    [second.id, SECOND_UNITS],
  ]);
  const usedBy = (user: User) => expectedUsed.get(user.id) ?? 0;

  await step("account usage", log, async () => {
    checkUsage(await account.accountUsage(month), month, unitsUsed, accountPlan, "account usage");
    return [undefined, `${String(unitsUsed)} units used in ${month} (accepted requests only)`];
  });

  await step("user usage", log, async () => {
    for (const [index, user] of users.entries()) {
      const usage = await account.userUsage(user.id, month);
      checkUsage(usage, month, usedBy(user), user.plan, `user ${String(index + 1)} usage`);
    }
    return [undefined, users.map(usedBy).join(" + ") + " units"];
  });

  const userPages = await step("walk GET /v1/users", log, async () => {
    const traversal = await collectAllPages(
      async (cursor) => {
        const page = await account.listUsers(
          cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
        );
        return { items: page.users, nextCursor: page.nextCursor };
      },
      (user) => user.id,
    );
    checkEqual(
      traversal.items.map((user) => user.id),
      users.map((user) => user.id),
      "users, oldest first",
    );
    return [
      traversal.pages,
      `${String(traversal.items.length)} users in ${String(traversal.pages)} pages`,
    ];
  });

  const usagePages = await step("walk GET /v1/usage/users", log, async () => {
    const traversal = await collectAllPages(
      async (cursor) => {
        const page = await account.listUserUsage(
          cursor === undefined ? { month, limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
        );
        checkEqual(page.month, month, "usage page month");
        return { items: page.users, nextCursor: page.nextCursor };
      },
      (usage) => usage.userId,
    );
    checkEqual(
      traversal.items.map((usage) => [usage.userId, usage.used]),
      users.map((user) => [user.id, usedBy(user)]).reverse(),
      "per-user usage, newest user first",
    );
    return [
      traversal.pages,
      `${String(traversal.items.length)} users in ${String(traversal.pages)} pages`,
    ];
  });

  const historyPages = await step("walk GET /v1/history", log, async () => {
    const traversal = await collectAllPages(
      async (cursor) => {
        const page = await account.listHistory(
          cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
        );
        return { items: page.decisions, nextCursor: page.nextCursor };
      },
      (decision) => decision.requestId,
    );
    // Newest first; exactly three decisions proves the retry recorded nothing new.
    checkEqual(traversal.items, [...decisions].reverse(), "history, newest first");
    return [
      traversal.pages,
      `${String(traversal.items.length)} decisions in ${String(traversal.pages)} pages, each as originally returned`,
    ];
  });

  return {
    accountId,
    month,
    users: users.length,
    acceptedDecisions: 2,
    rejectedDecisions: 1,
    unitsUsed,
    pages: { users: userPages, usage: usagePages, history: historyPages },
  };
}
