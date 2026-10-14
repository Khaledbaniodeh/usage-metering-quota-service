// Experiment B: the first page of the heavy user's oldest month,
// GET /v1/history?userId=<heavy user>&month=2025-01&limit=20, at a fixed, deliberately
// unsaturated open-model rate, so p95 reflects service time rather than queueing.
//
// Environment: API_KEY (from the seed's key file; never logged), HEAVY_USER_ID, RUN_LABEL,
// RATE (default 20/s), WARMUP_S (30), MEASURE_S (120), API_BASE_URL, RESULTS_DIR.

import { check } from "k6";
import http from "k6/http";
import {
  BASE_URL,
  envInt,
  envString,
  measuredThresholds,
  outcomes,
  params,
  parseBody,
  phasedScenarios,
  runLabel,
  SUMMARY_TREND_STATS,
  summaryOutputs,
} from "./lib.js";

const MONTH = "2025-01";
const LIMIT = 20;
const RATE = envInt("RATE", 20);
const WARMUP_S = envInt("WARMUP_S", 30);
const MEASURE_S = envInt("MEASURE_S", 120);
const LABEL = runLabel();
const USER_ID = envString("HEAVY_USER_ID", "");
const API_KEY = envString("API_KEY", "");

if (!/^[0-9a-f-]{36}$/.test(USER_ID)) {
  throw new Error("HEAVY_USER_ID must be the seeded heavy user's UUID");
}
if (API_KEY === "") {
  throw new Error("API_KEY is required");
}

const STAGES = [{ rate: RATE, seconds: MEASURE_S }];

export const options = {
  scenarios: phasedScenarios("readFirstPage", {
    warmupRate: RATE,
    warmupSeconds: WARMUP_S,
    stages: STAGES,
    preAllocatedVUs: Math.max(5, RATE / 2),
    maxVUs: Math.max(20, RATE * 2),
  }),
  thresholds: measuredThresholds(STAGES.length, { kind: "read" }),
  summaryTrendStats: SUMMARY_TREND_STATS,
  discardResponseBodies: false,
};

const URL_PATH = `${BASE_URL}/v1/history?userId=${USER_ID}&month=${MONTH}&limit=${LIMIT}`;

export function readFirstPage() {
  const response = http.get(
    URL_PATH,
    params(API_KEY, { endpoint: "history", kind: "read" }, [200]),
  );
  const page = response.status === 200 ? parseBody(response) : undefined;
  const decisions = page === undefined || !Array.isArray(page.decisions) ? [] : page.decisions;
  check(response, {
    "status 200": (r) => r.status === 200,
    "filters echoed": () => page !== undefined && page.userId === USER_ID && page.month === MONTH,
    "full page": () => decisions.length === LIMIT,
    "only the user's oldest month": () =>
      decisions.every((d) => d.userId === USER_ID && d.month === MONTH),
    "newest first": () =>
      decisions.every((d, i) => i === 0 || decisions[i - 1].processedAt >= d.processedAt),
    "more pages": () => page !== undefined && typeof page.nextCursor === "string",
  });
  if (response.status === 200) {
    outcomes.ok.add(1);
  } else {
    outcomes.unexpected.add(1);
  }
}

export function handleSummary(data) {
  return summaryOutputs(data, {
    name: "history",
    runLabel: LABEL,
    gating: false,
    kind: "read",
    stages: STAGES,
    config: {
      rate: RATE,
      warmupSeconds: WARMUP_S,
      measureSeconds: MEASURE_S,
      month: MONTH,
      limit: LIMIT,
    },
  });
}
