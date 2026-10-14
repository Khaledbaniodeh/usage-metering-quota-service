/**
 * The k6 summary schema written by load/k6/lib.js (handleSummary), validated before any report or
 * database check uses it, and the comparison of a run's manifest with what PostgreSQL stored.
 */

export const K6_SUMMARY_SCHEMA = "umqs-bench-k6/1";

export interface DurationStats {
  readonly count: number;
  readonly min: number;
  readonly med: number;
  readonly avg: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface K6Stage {
  readonly name: string;
  readonly rate: number;
  readonly seconds: number;
  readonly offeredIterations: number;
  readonly achievedIterations: number;
  readonly droppedIterations: number;
  readonly primaryDurationMs: DurationStats | null;
}

export interface K6Manifest {
  readonly requestIdPrefix: string;
  readonly expectedDecisions: number;
  readonly expectedAccepted: number;
  readonly batchesOk: number;
  readonly batchesBad: number;
}

export interface K6Summary {
  readonly schema: typeof K6_SUMMARY_SCHEMA;
  readonly workload: string;
  readonly runLabel: string;
  readonly gating: boolean;
  readonly thresholdsPassed: boolean;
  readonly measured: {
    readonly iterations: number;
    readonly droppedIterations: number;
    readonly httpRequests: number;
    readonly httpFailedRate: number | null;
    readonly checksRate: number | null;
    readonly primaryKind: string;
    readonly primaryDurationMs: DurationStats | null;
    readonly outcomes: Readonly<Record<OutcomeName, number>>;
  };
  readonly stages: readonly K6Stage[];
  readonly manifest: K6Manifest;
}

export const OUTCOME_NAMES = [
  "ok",
  "accepted",
  "rejected",
  "busyRetry",
  "conflict",
  "unexpected",
  "replayMatch",
  "replayMismatch",
  "batchBad",
] as const;
export type OutcomeName = (typeof OUTCOME_NAMES)[number];

export class K6SummaryError extends Error {
  override readonly name = "K6SummaryError";
}

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new K6SummaryError(`${what} must be an object`);
  }
  return value as Json;
}

function field(source: Json, key: string): unknown {
  return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function count(source: Json, key: string, what: string): number {
  const value = field(source, key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new K6SummaryError(`${what}.${key} must be a non-negative number`);
  }
  return value;
}

function stats(value: unknown, what: string): DurationStats | null {
  if (value === null) {
    return null;
  }
  const source = object(value, what);
  const keys = ["count", "min", "med", "avg", "p90", "p95", "p99", "max"] as const;
  const entries = keys.map((key) => [key, count(source, key, what)] as const);
  return Object.fromEntries(entries) as unknown as DurationStats;
}

function rate(source: Json, key: string, what: string): number | null {
  const value = field(source, key);
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new K6SummaryError(`${what}.${key} must be a rate between 0 and 1, or null`);
  }
  return value;
}

/** Validates a parsed k6 summary; throws on any missing or mistyped field. */
export function parseK6Summary(input: unknown): K6Summary {
  const root = object(input, "summary");
  if (field(root, "schema") !== K6_SUMMARY_SCHEMA) {
    throw new K6SummaryError(`summary.schema must be ${K6_SUMMARY_SCHEMA}`);
  }
  const workload = field(root, "workload");
  const runLabel = field(root, "runLabel");
  if (
    typeof workload !== "string" ||
    typeof runLabel !== "string" ||
    !/^[a-z0-9-]{1,40}$/.test(runLabel)
  ) {
    throw new K6SummaryError("summary.workload and summary.runLabel must be valid strings");
  }
  if (
    typeof field(root, "gating") !== "boolean" ||
    typeof field(root, "thresholdsPassed") !== "boolean"
  ) {
    throw new K6SummaryError("summary.gating and summary.thresholdsPassed must be booleans");
  }
  const measured = object(field(root, "measured"), "measured");
  const outcomesSource = object(field(measured, "outcomes"), "measured.outcomes");
  const outcomes = Object.fromEntries(
    OUTCOME_NAMES.map((name) => [name, count(outcomesSource, name, "measured.outcomes")]),
  ) as Record<OutcomeName, number>;
  const stagesSource = field(root, "stages");
  if (!Array.isArray(stagesSource) || stagesSource.length === 0) {
    throw new K6SummaryError("summary.stages must be a non-empty array");
  }
  const stages = stagesSource.map((value: unknown, index) => {
    const stage = object(value, `stages[${String(index)}]`);
    const name = field(stage, "name");
    if (typeof name !== "string") {
      throw new K6SummaryError(`stages[${String(index)}].name must be a string`);
    }
    const what = `stages[${String(index)}]`;
    return {
      name,
      rate: count(stage, "rate", what),
      seconds: count(stage, "seconds", what),
      offeredIterations: count(stage, "offeredIterations", what),
      achievedIterations: count(stage, "achievedIterations", what),
      droppedIterations: count(stage, "droppedIterations", what),
      primaryDurationMs: stats(field(stage, "primaryDurationMs"), `${what}.primaryDurationMs`),
    };
  });
  const manifest = object(field(root, "manifest"), "manifest");
  const prefix = field(manifest, "requestIdPrefix");
  if (prefix !== `${runLabel}.`) {
    throw new K6SummaryError("manifest.requestIdPrefix must be the run label followed by a dot");
  }
  const primaryKind = field(measured, "primaryKind");
  if (typeof primaryKind !== "string") {
    throw new K6SummaryError("measured.primaryKind must be a string");
  }
  return {
    schema: K6_SUMMARY_SCHEMA,
    workload,
    runLabel,
    gating: field(root, "gating") as boolean,
    thresholdsPassed: field(root, "thresholdsPassed") as boolean,
    measured: {
      iterations: count(measured, "iterations", "measured"),
      droppedIterations: count(measured, "droppedIterations", "measured"),
      httpRequests: count(measured, "httpRequests", "measured"),
      httpFailedRate: rate(measured, "httpFailedRate", "measured"),
      checksRate: rate(measured, "checksRate", "measured"),
      primaryKind,
      primaryDurationMs: stats(field(measured, "primaryDurationMs"), "measured.primaryDurationMs"),
      outcomes,
    },
    stages,
    manifest: {
      requestIdPrefix: prefix,
      expectedDecisions: count(manifest, "expectedDecisions", "manifest"),
      expectedAccepted: count(manifest, "expectedAccepted", "manifest"),
      batchesOk: count(manifest, "batchesOk", "manifest"),
      batchesBad: count(manifest, "batchesBad", "manifest"),
    },
  };
}

export interface StoredDecisions {
  readonly total: number;
  readonly accepted: number;
}

export interface ManifestCheck {
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
  readonly passed: boolean;
}

/** What k6 says it caused versus what PostgreSQL stored for the run's request-ID prefix. */
export function manifestChecks(manifest: K6Manifest, stored: StoredDecisions): ManifestCheck[] {
  const checks: [string, number, number][] = [
    // One stored decision per new request ID answered 200, none for replays or BUSY_RETRY.
    ["stored decisions = decided request IDs", manifest.expectedDecisions, stored.total],
    ["stored accepted decisions = accepted responses", manifest.expectedAccepted, stored.accepted],
    ["no race batch with an unexpected outcome", 0, manifest.batchesBad],
  ];
  return checks.map(([name, expected, actual]) => ({
    name,
    expected,
    actual,
    passed: expected === actual,
  }));
}
