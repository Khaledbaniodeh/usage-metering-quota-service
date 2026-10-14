// Consume workloads (POST /v1/consume), selected by SCENARIO:
//
//   distributed         gate: 50 accounts × 20 users, fixed rate, every 10th request replayed
//   hot-account         gate: 1 account × 200 users, fixed rate deliberately below saturation;
//                       zero dropped iterations and zero BUSY_RETRY are required
//   contention-spread   diagnostic (D1): 100 accounts × 10 users, stepped rates
//   contention-account  diagnostic (D2): 1 account × 1,000 users, stepped rates
//   contention-user     diagnostic (D3): 1 account × 1 user, stepped rates
//   race-identical      D4: 3 identical requests in parallel per iteration
//   race-conflicting    D5: 3 requests with one request ID and units 1/2/3 in parallel
//
// Accounts and users are created in setup() through the API; their keys live only in k6 memory.
// Every request ID starts with "<RUN_LABEL>." so the database check can find this run's rows.
// Sizes, rates and durations come from the environment (see the defaults below).

import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import {
  BASE_URL,
  envInt,
  envString,
  jsonParams,
  measuredThresholds,
  outcomes,
  parseBody,
  phasedScenarios,
  requireStatus,
  runLabel,
  SUMMARY_TREND_STATS,
  summaryOutputs,
} from "./lib.js";

const WORKLOADS = {
  distributed: { accounts: 50, users: 20, rate: 50, replay: true, gating: true, allowed: [200] },
  "hot-account": { accounts: 1, users: 200, rate: 20, replay: true, gating: true, allowed: [200] },
  "contention-spread": { accounts: 100, users: 10, stepped: true, allowed: [200, 503] },
  "contention-account": { accounts: 1, users: 1000, stepped: true, allowed: [200, 503] },
  "contention-user": { accounts: 1, users: 1, hotUser: true, stepped: true, allowed: [200, 503] },
  "race-identical": { accounts: 20, users: 10, rate: 10, race: "identical", allowed: [200, 503] },
  "race-conflicting": {
    accounts: 20,
    users: 10,
    rate: 10,
    race: "conflicting",
    allowed: [200, 409, 503],
  },
};

const NAME = envString("SCENARIO", "");
const WORKLOAD = Object.entries(WORKLOADS).find(([name]) => name === NAME)?.[1];
if (WORKLOAD === undefined) {
  throw new Error(`SCENARIO must be one of ${Object.keys(WORKLOADS).join(", ")}`);
}
const LABEL = runLabel();
const ACCOUNTS = envInt("ACCOUNTS", WORKLOAD.accounts);
const USERS = envInt("USERS_PER_ACCOUNT", WORKLOAD.users);
const WARMUP_S = envInt("WARMUP_S", WORKLOAD.stepped ? 20 : 30);
const STAGES = WORKLOAD.stepped
  ? envString("STEP_RATES", "25,50,100,200")
      .split(",")
      .map((rate) => ({ rate: envIntValue(rate), seconds: envInt("STAGE_S", 60) }))
  : [{ rate: envInt("RATE", WORKLOAD.rate), seconds: envInt("MEASURE_S", 120) }];
const FIRST_RATE = STAGES[0].rate;
const MAX_RATE = Math.max(...STAGES.map((stage) => stage.rate));

// Basic users allow 20 units per request; the hot user gets a custom plan allowing 100.
const OVERSIZE_UNITS = WORKLOAD.hotUser ? 101 : 21;

function envIntValue(raw) {
  if (!/^[1-9][0-9]{0,4}$/.test(raw.trim())) {
    throw new Error("STEP_RATES must be a comma-separated list of positive integers");
  }
  return Number(raw.trim());
}

export const options = {
  scenarios: phasedScenarios("consume", {
    warmupRate: FIRST_RATE,
    warmupSeconds: WARMUP_S,
    stages: STAGES,
    preAllocatedVUs: Math.max(10, FIRST_RATE),
    maxVUs: Math.max(50, MAX_RATE * 4),
  }),
  thresholds: measuredThresholds(STAGES.length, {
    kind: "new",
    // Saturation is what the contention ramps diagnose: dropped iterations are recorded there.
    requireNoDrops: !WORKLOAD.stepped,
    extra: WORKLOAD.gating ? { "umqs_busy_retry{phase:measure}": ["count==0"] } : {},
  }),
  summaryTrendStats: SUMMARY_TREND_STATS,
  setupTimeout: "600s",
};

function post(path, apiKey, body, expected) {
  return http.post(
    `${BASE_URL}${path}`,
    JSON.stringify(body),
    jsonParams(apiKey, { endpoint: "setup" }, expected),
  );
}

function put(path, apiKey, body) {
  return http.put(
    `${BASE_URL}${path}`,
    JSON.stringify(body),
    jsonParams(apiKey, { endpoint: "setup" }, [200]),
  );
}

/** One account on a custom plan with an allowance that never interferes, and its users. */
function createAccount(index) {
  const account = post("/v1/accounts", undefined, { name: `Bench ${LABEL} ${index}` }, [201]);
  requireStatus(account, 201, "create account");
  const apiKey = parseBody(account).apiKey;
  const plan = post(
    "/v1/plans",
    apiKey,
    {
      name: "Bench account",
      scope: "ACCOUNT",
      monthlyAllowance: 1000000000,
      maxUnitsPerRequest: 1000,
    },
    [201],
  );
  requireStatus(plan, 201, "create account plan");
  requireStatus(
    put("/v1/account/plan", apiKey, { planId: parseBody(plan).id }),
    200,
    "assign account plan",
  );

  let hotPlanId;
  if (WORKLOAD.hotUser) {
    const userPlan = post(
      "/v1/plans",
      apiKey,
      {
        name: "Bench hot user",
        scope: "USER",
        monthlyAllowance: 1000000000,
        maxUnitsPerRequest: 100,
      },
      [201],
    );
    requireStatus(userPlan, 201, "create user plan");
    hotPlanId = parseBody(userPlan).id;
  }
  const users = [];
  for (let u = 0; u < USERS; u += 1) {
    const user = post("/v1/users", apiKey, { name: `Bench user ${u}` }, [201]);
    requireStatus(user, 201, "create user");
    const userId = parseBody(user).id;
    if (hotPlanId !== undefined) {
      requireStatus(
        put(`/v1/users/${userId}/plan`, apiKey, { planId: hotPlanId }),
        200,
        "assign user plan",
      );
    }
    users.push(userId);
  }
  return { apiKey, users };
}

export function setup() {
  const accounts = [];
  for (let a = 0; a < ACCOUNTS; a += 1) {
    accounts.push(createAccount(a));
  }
  return { accounts };
}

/** The deterministic request of iteration i of the current scenario. */
function requestFor(data, i) {
  const account = data.accounts[i % ACCOUNTS];
  const userId = account.users[Math.floor(i / ACCOUNTS) % USERS];
  const units = i % 20 === 19 ? OVERSIZE_UNITS : 1 + (i % 10);
  return { account, body: { userId, units, requestId: `${LABEL}.${exec.scenario.name}.${i}` } };
}

/** Counts one response; returns the parsed decision of a 200. */
function record(response, request, kind) {
  const allowed = WORKLOAD.allowed.includes(response.status);
  if (!allowed) {
    outcomes.unexpected.add(1);
  }
  if (response.status === 503) {
    outcomes.busyRetry.add(1);
  } else if (response.status === 409) {
    outcomes.conflict.add(1);
  }
  if (response.status !== 200) {
    return undefined;
  }
  outcomes.ok.add(1);
  const decision = parseBody(response);
  check(response, {
    [`${kind}: decision echoes the request`]: () =>
      decision !== undefined &&
      decision.requestId === request.requestId &&
      decision.userId === request.userId,
  });
  return decision;
}

function single(data, i) {
  const { account, body } = requestFor(data, i);
  const send = (kind) =>
    http.post(
      `${BASE_URL}/v1/consume`,
      JSON.stringify(body),
      jsonParams(account.apiKey, { endpoint: "consume", kind }, WORKLOAD.allowed),
    );
  const response = send("new");
  const decision = record(response, body, "new");
  if (decision === undefined) {
    return;
  }
  check(response, { "new: units echoed": () => decision.units === body.units });
  outcomes.expectedDecisions.add(1);
  if (decision.accepted) {
    outcomes.accepted.add(1);
    outcomes.expectedAccepted.add(1);
  } else {
    outcomes.rejected.add(1);
  }
  if (WORKLOAD.replay && i % 10 === 9) {
    const replay = send("replay");
    if (replay.status === 200) {
      (replay.body === response.body ? outcomes.replayMatch : outcomes.replayMismatch).add(1);
    } else {
      record(replay, body, "replay");
    }
  }
}

function race(data, i) {
  const { account, body } = requestFor(data, i);
  const bodies =
    WORKLOAD.race === "identical"
      ? [body, body, body]
      : [1, 2, 3].map((units) => ({ ...body, units }));
  const responses = http.batch(
    bodies.map((b) => [
      "POST",
      `${BASE_URL}/v1/consume`,
      JSON.stringify(b),
      jsonParams(account.apiKey, { endpoint: "consume", kind: "new" }, WORKLOAD.allowed),
    ]),
  );
  const decisions = responses.map((response, index) =>
    // eslint-disable-next-line security/detect-object-injection -- index of the batch response, same order as bodies
    record(response, bodies[index], "race"),
  );
  const okBodies = responses.filter((r) => r.status === 200).map((r) => r.body);
  const conflicts = responses.filter((r) => r.status === 409).length;
  if (okBodies.length > 0) {
    outcomes.expectedDecisions.add(1);
    const winner = decisions.find((d) => d !== undefined);
    if (winner !== undefined && winner.accepted) {
      outcomes.expectedAccepted.add(1);
      outcomes.accepted.add(1);
    }
  }
  const ok =
    WORKLOAD.race === "identical"
      ? okBodies.length === 3 && okBodies.every((b) => b === okBodies[0])
      : okBodies.length === 1 && conflicts === 2;
  (ok ? outcomes.batchOk : outcomes.batchBad).add(1);
  if (WORKLOAD.race === "identical" && okBodies.length > 1) {
    (okBodies.every((b) => b === okBodies[0]) ? outcomes.replayMatch : outcomes.replayMismatch).add(
      1,
    );
  }
}

export function consume(data) {
  const i = exec.scenario.iterationInTest;
  if (WORKLOAD.race === undefined) {
    single(data, i);
  } else {
    race(data, i);
  }
}

export function handleSummary(data) {
  return summaryOutputs(data, {
    name: NAME,
    runLabel: LABEL,
    gating: WORKLOAD.gating === true,
    kind: "new",
    stages: STAGES,
    config: { accounts: ACCOUNTS, usersPerAccount: USERS, warmupSeconds: WARMUP_S, stages: STAGES },
  });
}
