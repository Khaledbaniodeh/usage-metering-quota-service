// Shared helpers of the k6 workloads (k6 2.3.0, plain JavaScript, no npm dependency).
//
// Every workload runs open-model constant-arrival-rate scenarios: a warm-up tagged phase=warmup,
// then measured scenarios tagged phase=measure. Thresholds and reported latency use measured
// traffic only. Nothing here logs a request or response body, a header or an API key; the summary
// written by handleSummary holds only counts, rates and latency statistics.

import http from "k6/http";
import { Counter } from "k6/metrics";

export const SUMMARY_SCHEMA = "umqs-bench-k6/1";

export const SUMMARY_TREND_STATS = ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max", "count"];

/** A string environment value, or the fallback. */
export function envString(name, fallback) {
  const value = Object.getOwnPropertyDescriptor(__ENV, name)?.value;
  return value === undefined || value === "" ? fallback : value;
}

/** A positive integer environment value; anything else stops the test before it starts. */
export function envInt(name, fallback) {
  const raw = envString(name, String(fallback));
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}

/** The run label prefixes every request ID, so the database check can find this run's rows. */
export function runLabel() {
  const label = envString("RUN_LABEL", "");
  if (!/^[a-z0-9-]{1,40}$/.test(label)) {
    throw new Error("RUN_LABEL must be 1-40 characters of a-z, 0-9 and -");
  }
  return label;
}

export const BASE_URL = envString("API_BASE_URL", "http://127.0.0.1:8080").replace(/\/+$/, "");

/** Counters every workload reports; each also carries the scenario's phase tag. */
export const outcomes = {
  ok: new Counter("umqs_ok"),
  accepted: new Counter("umqs_accepted"),
  rejected: new Counter("umqs_rejected"),
  busyRetry: new Counter("umqs_busy_retry"),
  conflict: new Counter("umqs_conflict"),
  unexpected: new Counter("umqs_unexpected"),
  replayMatch: new Counter("umqs_replay_match"),
  replayMismatch: new Counter("umqs_replay_mismatch"),
  expectedDecisions: new Counter("umqs_expected_decisions"),
  expectedAccepted: new Counter("umqs_expected_accepted"),
  batchOk: new Counter("umqs_batch_ok"),
  batchBad: new Counter("umqs_batch_bad"),
};

/**
 * A warm-up scenario followed by one or more measured stages, all constant-arrival-rate.
 * `stages` is a list of { rate, seconds }; each becomes scenario "measure-<n>".
 */
export function phasedScenarios(
  exec,
  { warmupRate, warmupSeconds, stages, preAllocatedVUs, maxVUs },
) {
  const scenarios = {
    warmup: {
      executor: "constant-arrival-rate",
      exec,
      rate: warmupRate,
      timeUnit: "1s",
      duration: `${warmupSeconds}s`,
      preAllocatedVUs,
      maxVUs,
      tags: { phase: "warmup" },
    },
  };
  let start = warmupSeconds;
  stages.forEach((stage, index) => {
    scenarios[`measure-${index + 1}`] = {
      executor: "constant-arrival-rate",
      exec,
      rate: stage.rate,
      timeUnit: "1s",
      duration: `${stage.seconds}s`,
      startTime: `${start}s`,
      preAllocatedVUs,
      maxVUs,
      gracefulStop: "10s",
      tags: { phase: "measure", stage: String(index + 1) },
    };
    start += stage.seconds;
  });
  return scenarios;
}

/**
 * Thresholds on measured traffic only. Every listed sub-metric also appears in the summary data.
 * `kind` is the request kind whose latency is the workload's primary metric (new or read);
 * `requireNoDrops` fails the run on any dropped measured iteration (off only for saturation ramps);
 * `extra` adds workload-specific thresholds (always phase:measure).
 */
export function measuredThresholds(stageCount, { kind, requireNoDrops = true, extra = {} }) {
  const thresholds = {
    "http_req_failed{phase:measure}": ["rate==0"],
    "checks{phase:measure}": ["rate==1"],
    "umqs_unexpected{phase:measure}": ["count==0"],
    "iterations{phase:measure}": ["count>0"],
    "http_req_duration{phase:measure}": ["max>=0"],
    [`http_req_duration{phase:measure,kind:${kind}}`]: ["max>=0"],
    "umqs_ok{phase:measure}": ["count>=0"],
    "umqs_accepted{phase:measure}": ["count>=0"],
    "umqs_rejected{phase:measure}": ["count>=0"],
    "umqs_busy_retry{phase:measure}": ["count>=0"],
    "umqs_conflict{phase:measure}": ["count>=0"],
    "umqs_replay_match{phase:measure}": ["count>=0"],
    "umqs_replay_mismatch{phase:measure}": ["count==0"],
    "umqs_batch_bad{phase:measure}": ["count==0"],
    ...extra,
  };
  // k6 tags dropped iterations with the scenario name only, so each measured stage is listed.
  for (let stage = 1; stage <= stageCount; stage += 1) {
    thresholds[`dropped_iterations{scenario:measure-${stage}}`] = [
      requireNoDrops ? "count==0" : "count>=0",
    ];
    thresholds[`iterations{scenario:measure-${stage}}`] = ["count>0"];
    thresholds[`http_req_duration{scenario:measure-${stage},kind:${kind}}`] = ["max>=0"];
  }
  return thresholds;
}

/** Request parameters; the API key goes only into this header and is never logged. */
export function params(apiKey, tags, expected) {
  const headers = { accept: "application/json" };
  if (typeof apiKey === "string") {
    headers["x-api-key"] = apiKey;
  }
  return {
    headers,
    tags,
    timeout: "10s",
    responseCallback: http.expectedStatuses(...expected),
  };
}

export function jsonParams(apiKey, tags, expected) {
  const base = params(apiKey, tags, expected);
  return { ...base, headers: { ...base.headers, "content-type": "application/json" } };
}

/** Parses a JSON body; undefined instead of throwing, and never echoes it. */
export function parseBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

/** Fails setup with the status only: setup responses can carry API keys. */
export function requireStatus(response, status, what) {
  if (response.status !== status) {
    throw new Error(`${what}: expected HTTP ${status}, got ${response.status}`);
  }
}

function metric(data, name) {
  const found = Object.getOwnPropertyDescriptor(data.metrics, name)?.value;
  return found === undefined ? undefined : found.values;
}

function count(data, name) {
  const values = metric(data, name);
  return values === undefined ? 0 : values.count || 0;
}

function trend(data, name) {
  const values = metric(data, name);
  if (values === undefined) {
    return null;
  }
  return {
    count: values.count,
    min: values.min,
    med: values.med,
    avg: values.avg,
    p90: values["p(90)"],
    p95: values["p(95)"],
    p99: values["p(99)"],
    max: values.max,
  };
}

function thresholdsPassed(data) {
  return Object.values(data.metrics).every((m) =>
    Object.values(m.thresholds || {}).every((threshold) => threshold.ok),
  );
}

/**
 * The machine-readable summary: counts, rates and latency of measured traffic, offered versus
 * achieved iterations, the run manifest for the database check, and whether every threshold held.
 */
export function buildSummary(data, workload) {
  const stages = workload.stages.map((stage, index) => {
    const name = `measure-${index + 1}`;
    return {
      name,
      rate: stage.rate,
      seconds: stage.seconds,
      offeredIterations: stage.rate * stage.seconds,
      achievedIterations: count(data, `iterations{scenario:${name}}`),
      droppedIterations: count(data, `dropped_iterations{scenario:${name}}`),
      primaryDurationMs: trend(data, `http_req_duration{scenario:${name},kind:${workload.kind}}`),
    };
  });
  return {
    schema: SUMMARY_SCHEMA,
    workload: workload.name,
    runLabel: workload.runLabel,
    gating: workload.gating,
    config: workload.config,
    testRunDurationMs: data.state.testRunDurationMs,
    thresholdsPassed: thresholdsPassed(data),
    measured: {
      iterations: count(data, "iterations{phase:measure}"),
      droppedIterations: stages.reduce((sum, stage) => sum + stage.droppedIterations, 0),
      httpRequests: count(data, "http_req_duration{phase:measure}"),
      httpFailedRate: (metric(data, "http_req_failed{phase:measure}") || {}).rate ?? null,
      checksRate: (metric(data, "checks{phase:measure}") || {}).rate ?? null,
      requestDurationMs: trend(data, "http_req_duration{phase:measure}"),
      primaryKind: workload.kind,
      primaryDurationMs: trend(data, `http_req_duration{phase:measure,kind:${workload.kind}}`),
      outcomes: {
        ok: count(data, "umqs_ok{phase:measure}"),
        accepted: count(data, "umqs_accepted{phase:measure}"),
        rejected: count(data, "umqs_rejected{phase:measure}"),
        busyRetry: count(data, "umqs_busy_retry{phase:measure}"),
        conflict: count(data, "umqs_conflict{phase:measure}"),
        unexpected: count(data, "umqs_unexpected{phase:measure}"),
        replayMatch: count(data, "umqs_replay_match{phase:measure}"),
        replayMismatch: count(data, "umqs_replay_mismatch{phase:measure}"),
        batchBad: count(data, "umqs_batch_bad{phase:measure}"),
      },
    },
    stages,
    // All phases: the database holds the warm-up's decisions too.
    manifest: {
      requestIdPrefix: `${workload.runLabel}.`,
      expectedDecisions: count(data, "umqs_expected_decisions"),
      expectedAccepted: count(data, "umqs_expected_accepted"),
      batchesOk: count(data, "umqs_batch_ok"),
      batchesBad: count(data, "umqs_batch_bad"),
    },
  };
}

/** handleSummary result: the JSON file plus a short, secret-free line on stdout. */
export function summaryOutputs(data, workload) {
  const summary = buildSummary(data, workload);
  const dir = envString("RESULTS_DIR", "/results");
  const p95 = summary.measured.primaryDurationMs;
  const line =
    `${summary.workload} ${summary.runLabel}: thresholds ${summary.thresholdsPassed ? "passed" : "FAILED"}, ` +
    `measured iterations ${summary.measured.iterations}, dropped ${summary.measured.droppedIterations}, ` +
    `p95 ${p95 === null ? "n/a" : p95.p95.toFixed(2)} ms, unexpected ${summary.measured.outcomes.unexpected}\n`;
  return {
    stdout: line,
    [`${dir}/k6-${summary.runLabel}.json`]: `${JSON.stringify(summary, null, 2)}\n`,
  };
}
