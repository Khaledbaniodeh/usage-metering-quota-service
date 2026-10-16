import type { ConsumeResult, PublicApi } from "./api-client.js";
import type { ConsumeRequest, Decision, Plan, User } from "./api-types.js";
import {
  check,
  checkDecision,
  checkEqual,
  checkForm,
  CheckFailed,
  checkListedUsage,
  checkMonthlyUsage,
  describeDecision,
  FormMismatch,
  limitsOf,
  type DecisionExpectation,
  type UsageForm,
} from "./checks.js";
import { collectAllPages } from "./pagination.js";

/**
 * The example workflow: one pass through the public API that demonstrates every required
 * behavior and checks every outcome it depends on. Expectations are derived from earlier responses
 * (plan limits, IDs, the decisions' month), never from the clock or hard-coded dates.
 *
 * The scenario, with the predefined plans (Starter 10,000/month and 100/request for the account;
 * Basic 1,000 and 20, Premium 10,000 and 100 for users):
 *
 * 1. Three users; user 2 switches to Premium, users 1 and 3 stay on Basic.
 * 2. User 1 consumes 10 units (accepted), and the retry of that request changes nothing.
 * 3. User 1 asks for 25: above Basic's 20 per request, so the USER rule rejects it.
 * 4. User 2 asks for the same 25: Premium allows it. Account usage is now 10 + 25 = 35.
 * 5. A custom ACCOUNT plan allowing exactly 35 units a month is created and assigned.
 * 6. User 2 asks for 5: Premium would allow it, but the shared ACCOUNT allowance rejects it.
 * 7. The custom plan is raised to 40, and the same 5-unit request (a new request ID) is accepted.
 *
 * Final usage: account 40 = user 1 10 + user 2 30 + user 3 0, from 3 accepted and 2 rejected
 * decisions; nothing in the client changes between the rejection and the acceptance.
 */

export const USER_COUNT = 3;
/** Small enough that every list needs one page per item. */
export const PAGE_LIMIT = 1;
/** Accepted for the Basic user. */
export const BASIC_UNITS = 10;
/** Above Basic's per-request limit and within Premium's. */
export const PREMIUM_UNITS = 25;
/** Blocked once the shared allowance is used up; accepted after the plan is raised by this much. */
export const FINAL_UNITS = 5;
export const SHARED_PLAN_NAME = "Example shared cap";

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

/** The fields of a plan that accounts, users and decisions report. */
function summaryOf(plan: Plan): Plan {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    scope: plan.scope,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
  };
}

/** The scenario's arithmetic holds only if the predefined plans still have room for it. */
function checkScenarioFits(starter: Plan, basic: Plan, premium: Plan): void {
  const fits =
    BASIC_UNITS <= basic.maxUnitsPerRequest &&
    PREMIUM_UNITS > basic.maxUnitsPerRequest &&
    PREMIUM_UNITS <= premium.maxUnitsPerRequest &&
    Math.max(BASIC_UNITS, PREMIUM_UNITS, FINAL_UNITS) <= starter.maxUnitsPerRequest &&
    BASIC_UNITS <= basic.monthlyAllowance &&
    PREMIUM_UNITS + 2 * FINAL_UNITS <= premium.monthlyAllowance &&
    BASIC_UNITS + PREMIUM_UNITS + FINAL_UNITS <= starter.monthlyAllowance;
  check(
    fits,
    `the predefined plans (Starter ${limitsOf(starter)}, Basic ${limitsOf(basic)}, Premium ${limitsOf(premium)}) no longer fit the example's units ${String(BASIC_UNITS)}, ${String(PREMIUM_UNITS)} and ${String(FINAL_UNITS)}`,
  );
}

function predefinedPlan(plans: readonly Plan[], code: string): Plan {
  const plan = plans.find((candidate) => candidate.code === code);
  check(plan !== undefined, `GET /v1/plans?scope=USER lists no predefined plan "${code}"`);
  return summaryOf(plan);
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
  const { accountId, starter, account } = await step("create account", log, async () => {
    const created = await api.createAccount(`Example client ${runId}`);
    checkEqual(
      [created.account.plan.scope, created.account.plan.code],
      ["ACCOUNT", "starter"],
      "new account plan [scope, code]",
    );
    const result = {
      accountId: created.account.id,
      starter: summaryOf(created.account.plan),
      account: api.forAccount(created.apiKey),
    };
    return [
      result,
      `${created.account.id} on plan ${created.account.plan.name} (${limitsOf(created.account.plan)})`,
    ];
  });

  const created = await step("create users", log, async () => {
    const users: User[] = [];
    for (let index = 1; index <= USER_COUNT; index += 1) {
      const user = await account.createUser(`Example user ${String(index)}`);
      checkEqual(
        [user.plan.scope, user.plan.code],
        ["USER", "basic"],
        `user ${String(index)} plan [scope, code]`,
      );
      users.push(user);
    }
    return [users, `${String(users.length)} users on plan Basic`];
  });
  const [basicUser, premiumUser, idleUser] = created;
  check(
    basicUser !== undefined && premiumUser !== undefined && idleUser !== undefined,
    "three users were created",
  );

  const { basic, premium } = await step("find the predefined user plans", log, async () => {
    const { plans } = await account.listPlans("USER");
    check(
      plans.every((plan) => plan.scope === "USER"),
      "GET /v1/plans?scope=USER returned a plan of another scope",
    );
    const found = {
      basic: predefinedPlan(plans, "basic"),
      premium: predefinedPlan(plans, "premium"),
    };
    checkScenarioFits(starter, found.basic, found.premium);
    return [found, `Basic (${limitsOf(found.basic)}), Premium (${limitsOf(found.premium)})`];
  });

  const switched = await step("switch user 2 to Premium", log, async () => {
    const user = await account.assignUserPlan(premiumUser.id, premium.id);
    checkEqual(user.id, premiumUser.id, "switched user ID");
    checkEqual(summaryOf(user.plan), premium, "user 2 plan after the switch");
    return [user, `${user.id} now on plan ${user.plan.name} (${limitsOf(user.plan)})`];
  });
  // Every later check uses the plans the users are on now.
  const users: readonly User[] = [basicUser, switched, idleUser];

  await step("users on different plans", log, async () => {
    // GET /v1/users/{userId} answers only for users of the calling account.
    const first = await account.getUser(basicUser.id);
    const second = await account.getUser(premiumUser.id);
    checkEqual([first.id, summaryOf(first.plan)], [basicUser.id, basic], "user 1 [id, plan]");
    checkEqual([second.id, summaryOf(second.plan)], [premiumUser.id, premium], "user 2 [id, plan]");
    check(first.plan.id !== second.plan.id, "users 1 and 2 must be on different plans");
    return [
      undefined,
      `user 1 on ${first.plan.name} (${limitsOf(first.plan)}), user 2 on ${second.plan.name} (${limitsOf(second.plan)}), both read with this account's key`,
    ];
  });

  const decisions: Decision[] = [];
  let month: string | undefined;
  /** Sends one consume request, checks the decision exactly and logs its safe summary. */
  async function decide(
    name: string,
    request: ConsumeRequest,
    expected: Omit<DecisionExpectation, keyof ConsumeRequest>,
    explain?: (decision: Decision) => string,
  ): Promise<ConsumeResult> {
    return step(name, log, async () => {
      const result = await account.consume(request);
      const decisionMonth = result.decision.month;
      if (month !== undefined && decisionMonth !== month) {
        throw monthChanged(month);
      }
      month = decisionMonth;
      checkDecision(result.decision, { ...request, ...expected });
      decisions.push(result.decision);
      const extra = explain === undefined ? "" : `; ${explain(result.decision)}`;
      return [result, `${describeDecision(result.decision)}${extra}`];
    });
  }

  let accountUsed = 0;
  let accountPlan: Plan = starter;
  const usedBy = new Map<string, number>();
  const used = (user: User) => usedBy.get(user.id) ?? 0;
  const level = (plan: Plan, value: number) => ({ plan, used: value });

  // 2. An accepted request, and its retry.
  const firstRequest = {
    userId: basicUser.id,
    units: BASIC_UNITS,
    requestId: `${runId}-basic-accepted`,
  };
  const accepted = await decide("accepted request", firstRequest, {
    accepted: true,
    blockingRule: null,
    blockingLevel: null,
    user: level(basic, BASIC_UNITS),
    account: level(accountPlan, BASIC_UNITS),
  });
  usedBy.set(basicUser.id, BASIC_UNITS);
  accountUsed = BASIC_UNITS;

  await step("idempotent retry", log, async () => {
    const replay = await account.consume(firstRequest);
    const mismatch = replayMismatch(accepted, replay);
    check(mismatch === undefined, mismatch ?? "");
    const usage = await account.accountUsage();
    checkEqual(usage.used, accountUsed, "account usage after the retry");
    return [
      undefined,
      `identical response (${String(replay.rawBody.length)} bytes); account usage still ${String(usage.used)}`,
    ];
  });

  // 3. The Basic user's own per-request limit blocks 25 units; nothing is counted.
  await decide(
    "user-limit rejection",
    { userId: basicUser.id, units: PREMIUM_UNITS, requestId: `${runId}-basic-rejected` },
    {
      accepted: false,
      blockingRule: "MAX_UNITS_PER_REQUEST",
      blockingLevel: "USER",
      user: level(basic, used(basicUser)),
      account: level(accountPlan, accountUsed),
    },
    () => `Basic allows ${String(basic.maxUnitsPerRequest)} per request; nothing was counted`,
  );

  // 4. The same amount for the Premium user is accepted: the user plan changes what is allowed.
  await decide(
    "Premium user allowed the same amount",
    { userId: premiumUser.id, units: PREMIUM_UNITS, requestId: `${runId}-premium-accepted` },
    {
      accepted: true,
      blockingRule: null,
      blockingLevel: null,
      user: level(premium, PREMIUM_UNITS),
      account: level(accountPlan, accountUsed + PREMIUM_UNITS),
    },
    () => `Premium allows ${String(premium.maxUnitsPerRequest)} per request`,
  );
  usedBy.set(premiumUser.id, PREMIUM_UNITS);
  accountUsed += PREMIUM_UNITS;

  // 5. A custom ACCOUNT plan whose monthly allowance is exactly the usage so far.
  const sharedPlan = await step("create a shared account plan", log, async () => {
    const plan = await account.createPlan({
      name: SHARED_PLAN_NAME,
      scope: "ACCOUNT",
      monthlyAllowance: accountUsed,
      maxUnitsPerRequest: starter.maxUnitsPerRequest,
    });
    checkEqual(
      [plan.code, plan.name, plan.scope, plan.monthlyAllowance, plan.maxUnitsPerRequest],
      [null, SHARED_PLAN_NAME, "ACCOUNT", accountUsed, starter.maxUnitsPerRequest],
      "created plan [code, name, scope, monthlyAllowance, maxUnitsPerRequest]",
    );
    return [
      summaryOf(plan),
      `${plan.id} "${plan.name}" (${limitsOf(plan)}): the account's usage so far`,
    ];
  });

  await step("assign it to the account", log, async () => {
    const updated = await account.assignAccountPlan(sharedPlan.id);
    checkEqual(summaryOf(updated.plan), sharedPlan, "account plan after the switch");
    const usage = await account.accountUsage();
    checkEqual(
      [usage.used, usage.monthlyAllowance, usage.remaining],
      [accountUsed, sharedPlan.monthlyAllowance, 0],
      "account usage on the shared plan [used, monthlyAllowance, remaining]",
    );
    return [
      undefined,
      `account now on "${updated.plan.name}": ${String(usage.used)} of ${String(sharedPlan.monthlyAllowance)} used, 0 remaining`,
    ];
  });
  accountPlan = sharedPlan;

  // 6. Within the Premium user's own limits, but the shared allowance is used up.
  await decide(
    "account-limit rejection",
    { userId: premiumUser.id, units: FINAL_UNITS, requestId: `${runId}-account-rejected` },
    {
      accepted: false,
      blockingRule: "MONTHLY_ALLOWANCE",
      blockingLevel: "ACCOUNT",
      user: level(premium, used(premiumUser)),
      account: level(accountPlan, accountUsed),
    },
    (decision) => {
      check(
        decision.units <= decision.user.maxUnitsPerRequest &&
          decision.units <= decision.user.remaining,
        "the user's own plan must allow the request that the account rejects",
      );
      return `user plan alone would allow it (${String(decision.units)} <= ${String(decision.user.maxUnitsPerRequest)} per request, ${String(decision.user.remaining)} remaining); nothing was counted`;
    },
  );

  // 7. Raising the shared allowance lets the same request through; the client code is unchanged.
  const raisedPlan = await step("raise the shared plan", log, async () => {
    const raised = await account.updatePlan(sharedPlan.id, {
      monthlyAllowance: sharedPlan.monthlyAllowance + FINAL_UNITS,
    });
    checkEqual(
      [raised.id, raised.monthlyAllowance, raised.maxUnitsPerRequest],
      [sharedPlan.id, sharedPlan.monthlyAllowance + FINAL_UNITS, sharedPlan.maxUnitsPerRequest],
      "updated plan [id, monthlyAllowance, maxUnitsPerRequest]",
    );
    return [
      summaryOf(raised),
      `"${raised.name}" monthly allowance ${String(sharedPlan.monthlyAllowance)} -> ${String(raised.monthlyAllowance)}`,
    ];
  });
  accountPlan = raisedPlan;

  await decide(
    "accepted after the plan update",
    { userId: premiumUser.id, units: FINAL_UNITS, requestId: `${runId}-account-accepted` },
    {
      accepted: true,
      blockingRule: null,
      blockingLevel: null,
      user: level(premium, used(premiumUser) + FINAL_UNITS),
      account: level(accountPlan, accountUsed + FINAL_UNITS),
    },
    () => `the ${String(FINAL_UNITS)} units the shared limit rejected before`,
  );
  usedBy.set(premiumUser.id, used(premiumUser) + FINAL_UNITS);
  accountUsed += FINAL_UNITS;

  check(month !== undefined, "the workflow recorded decisions");
  const decisionMonth = month;

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
        if (
          error instanceof FormMismatch &&
          (await account.accountUsage()).month !== decisionMonth
        ) {
          throw monthChanged(decisionMonth);
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
      if (usage.month > decisionMonth) {
        throw monthChanged(decisionMonth);
      }
      checkMonthlyUsage(
        usage,
        { month: decisionMonth, used: accountUsed, plan: accountPlan, form },
        "account usage",
      );
      return [
        undefined,
        `${String(accountUsed)} units used in ${decisionMonth}, ${String(usage.remaining)} remaining on "${accountPlan.name}" (accepted requests only)`,
      ];
    }),
  );

  await step(
    "user usage",
    log,
    unlessMonthChanged(async () => {
      for (const [index, user] of users.entries()) {
        const usage = await account.userUsage(user.id, decisionMonth);
        checkMonthlyUsage(
          usage,
          { month: decisionMonth, used: used(user), plan: user.plan, form },
          `user ${String(index + 1)} usage`,
        );
      }
      return [
        undefined,
        `${users.map(used).join(" + ")} = ${String(accountUsed)} units, the account's total`,
      ];
    }),
  );
  checkEqual(
    users.reduce((total, user) => total + used(user), 0),
    accountUsed,
    "the users' usage adds up to the account's",
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
      traversal.items.map((user) => [user.id, user.plan.code]),
      users.map((user) => [user.id, user.plan.code]),
      "users and their plans, oldest first",
    );
    return [
      traversal.pages,
      `${String(traversal.items.length)} users in ${String(traversal.pages)} pages, plans ${users.map((user) => user.plan.name).join(", ")}`,
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
            cursor === undefined
              ? { month: decisionMonth, limit: PAGE_LIMIT }
              : { limit: PAGE_LIMIT, cursor },
          );
          const what = `usage page ${String(page)}`;
          checkEqual(result.month, decisionMonth, `${what} month`);
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
        checkListedUsage(item, { user, used: used(user), form }, `per-user usage of ${user.id}`);
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
    // Newest first; exactly the five decisions proves the retry recorded nothing new, and equal
    // values prove that later plan changes left the recorded decisions untouched.
    checkEqual(traversal.items, [...decisions].reverse(), "history, newest first");
    return [
      traversal.pages,
      `${String(traversal.items.length)} decisions in ${String(traversal.pages)} pages, each as originally returned`,
    ];
  });

  const acceptedDecisions = decisions.filter((decision) => decision.accepted).length;
  return {
    accountId,
    month: decisionMonth,
    users: users.length,
    acceptedDecisions,
    rejectedDecisions: decisions.length - acceptedDecisions,
    unitsUsed: accountUsed,
    pages: { users: userPages, usage: usagePages, history: historyPages },
  };
}
