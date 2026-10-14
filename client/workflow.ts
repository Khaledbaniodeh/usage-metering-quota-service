import type { ConsumeResult, PublicApi } from "./api-client.js";
import type { User } from "./api-types.js";
import {
  check,
  checkDecision,
  checkEqual,
  checkForm,
  CheckFailed,
  checkListedUsage,
  checkMonthlyUsage,
  FormMismatch,
  type UsageForm,
} from "./checks.js";
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

function monthChanged(month: string): CheckFailed {
  return new CheckFailed(
    `the UTC month changed during the run (the decisions are in ${month}); run the example again`,
  );
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

  const firstRequest = { userId: first.id, units: FIRST_UNITS, requestId: `${runId}-accepted-1` };
  const accepted = await step("accepted request", log, async () => {
    const result = await account.consume(firstRequest);
    checkDecision(result.decision, {
      ...firstRequest,
      accepted: true,
      blockingRule: null,
      blockingLevel: null,
      userUsed: FIRST_UNITS,
      accountUsed: FIRST_UNITS,
    });
    return [result, `${String(FIRST_UNITS)} units accepted for user 1`];
  });

  await step("idempotent retry", log, async () => {
    const replay = await account.consume(firstRequest);
    const mismatch = replayMismatch(accepted, replay);
    check(mismatch === undefined, mismatch ?? "");
    return [undefined, `identical response (${String(replay.rawBody.length)} bytes)`];
  });

  const unitsUsed = FIRST_UNITS + SECOND_UNITS;
  const secondRequest = {
    userId: second.id,
    units: SECOND_UNITS,
    requestId: `${runId}-accepted-2`,
  };
  const secondAccepted = await step("second accepted request", log, async () => {
    const result = await account.consume(secondRequest);
    checkDecision(result.decision, {
      ...secondRequest,
      accepted: true,
      blockingRule: null,
      blockingLevel: null,
      userUsed: SECOND_UNITS,
      accountUsed: unitsUsed,
    });
    return [result, `${String(SECOND_UNITS)} units accepted for user 2`];
  });

  // The user's per-request limit is the first rule checked, so one unit more is always blocked there.
  const rejectedRequest = {
    userId: first.id,
    units: userPlan.maxUnitsPerRequest + 1,
    requestId: `${runId}-rejected-1`,
  };
  const rejected = await step("quota rejection", log, async () => {
    const result = await account.consume(rejectedRequest);
    checkDecision(result.decision, {
      ...rejectedRequest,
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
      userUsed: FIRST_UNITS,
      accountUsed: unitsUsed,
    });
    return [result, `${String(rejectedRequest.units)} units blocked by USER MAX_UNITS_PER_REQUEST`];
  });

  const decisions = [accepted.decision, secondAccepted.decision, rejected.decision];
  const month = accepted.decision.month;
  if (decisions.some((decision) => decision.month !== month)) {
    throw new WorkflowFailure("quota rejection", monthChanged(month).message);
  }
  // Accepted units per user; the rejected request counted nothing.
  const expectedUsed = new Map([
    [first.id, FIRST_UNITS],
    [second.id, SECOND_UNITS],
  ]);
  const usedBy = (user: User) => expectedUsed.get(user.id) ?? 0;

  /**
   * A usage response in the other month form is a defect, unless the UTC month changed since the
   * decisions: then the run cannot be judged and is reported as such.
   */
  const unlessMonthChanged =
    <T>(run: () => Promise<[T, string]>) =>
    async (): Promise<[T, string]> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof FormMismatch && (await account.accountUsage()).month !== month) {
          throw monthChanged(month);
        }
        throw error;
      }
    };

  // Without ?month= the service reports its current month, which must use the current-month form
  // and be the decisions' month. Every later usage response must use this same form.
  const form: UsageForm = "current";
  await step(
    "account usage",
    log,
    unlessMonthChanged(async () => {
      const usage = await account.accountUsage();
      if (usage.month > month) {
        throw monthChanged(month);
      }
      checkMonthlyUsage(
        usage,
        { month, used: unitsUsed, plan: accountPlan, form },
        "account usage",
      );
      return [undefined, `${String(unitsUsed)} units used in ${month} (accepted requests only)`];
    }),
  );

  await step(
    "user usage",
    log,
    unlessMonthChanged(async () => {
      for (const [index, user] of users.entries()) {
        const usage = await account.userUsage(user.id, month);
        checkMonthlyUsage(
          usage,
          { month, used: usedBy(user), plan: user.plan, form },
          `user ${String(index + 1)} usage`,
        );
      }
      return [undefined, users.map(usedBy).join(" + ") + " units"];
    }),
  );

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

  const usagePages = await step(
    "walk GET /v1/usage/users",
    log,
    unlessMonthChanged(async () => {
      let page = 0;
      const traversal = await collectAllPages(
        async (cursor) => {
          page += 1;
          const result = await account.listUserUsage(
            cursor === undefined ? { month, limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
          );
          const what = `usage page ${String(page)}`;
          checkEqual(result.month, month, `${what} month`);
          // The same flag on every page, agreeing with the form of the other usage responses.
          checkForm(result.currentMonth ? "current" : "past", form, `${what} currentMonth`);
          return { items: result.users, nextCursor: result.nextCursor };
        },
        (usage) => usage.userId,
      );
      const newestFirst = [...users].reverse();
      checkEqual(
        traversal.items.map((usage) => usage.userId),
        newestFirst.map((user) => user.id),
        "per-user usage order, newest user first",
      );
      // The order matched, so every listed item belongs to one of the created users.
      const usersById = new Map(users.map((user) => [user.id, user]));
      for (const item of traversal.items) {
        const user = usersById.get(item.userId);
        check(user !== undefined, `per-user usage lists an unknown user ${item.userId}`);
        checkListedUsage(item, { user, used: usedBy(user), form }, `per-user usage of ${user.id}`);
      }
      return [
        traversal.pages,
        `${String(traversal.items.length)} users in ${String(traversal.pages)} pages, live plan and limits checked`,
      ];
    }),
  );

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
