/**
 * Statistics and the approved decision rules for the combined history index. The rules are
 * encoded exactly once, here, and unit-tested; reports call them instead of re-deriving them.
 *
 * Approved protocol (docs/performance.md):
 * - History: the median of 3 measured k6 p95 values, and the median "rows removed by filter" of
 *   5 warm EXPLAIN executions of the chosen plan. The criterion holds when the p95 exceeds 50 ms
 *   or the rows removed exceed 100 × the page limit.
 * - Consume: 5 predetermined runs per variant on BOTH gating workloads (distributed and
 *   unsaturated hot account). Per workload, a baseline p95 spread of 5% or more is inconclusive;
 *   otherwise the median p95 regression must stay below 5%.
 * - The index is eligible only when the history criterion holds and both gates pass. Only the S2
 *   dataset decides; S3 is a sensitivity experiment.
 */

export const HISTORY_P95_LIMIT_MS = 50;
export const ROWS_REMOVED_FACTOR = 100;
export const HISTORY_RUNS = 3;
export const WARM_EXPLAIN_RUNS = 5;
export const AB_RUNS_PER_VARIANT = 5;
export const MAX_REGRESSION = 0.05;
export const MAX_BASELINE_SPREAD = 0.05;

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

function checkValues(values: readonly number[], what: string, count?: number): void {
  if (count !== undefined && values.length !== count) {
    throw new ProtocolError(
      `${what}: the protocol requires exactly ${String(count)} values, got ${String(values.length)}`,
    );
  }
  if (values.length === 0) {
    throw new ProtocolError(`${what}: no values`);
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ProtocolError(`${what}: every value must be a finite, non-negative number`);
  }
}

export function median(values: readonly number[], what = "values"): number {
  checkValues(values, what);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle) ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted.at(middle - 1) ?? 0) + upper) / 2;
}

export interface Summary {
  readonly values: readonly number[];
  readonly median: number;
  readonly min: number;
  readonly max: number;
  /** (max - min) / median: run-to-run spread relative to the median; 0 when the median is 0. */
  readonly spread: number;
}

export function summarize(values: readonly number[], what = "values", count?: number): Summary {
  checkValues(values, what, count);
  const mid = median(values, what);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { values: [...values], median: mid, min, max, spread: mid === 0 ? 0 : (max - min) / mid };
}

/** Relative change of the candidate median against the baseline median (0.05 = 5% slower). */
export function regression(baseline: Summary, candidate: Summary): number {
  if (baseline.median === 0) {
    throw new ProtocolError("regression: the baseline median is 0");
  }
  return candidate.median / baseline.median - 1;
}

export interface HistoryEvidence {
  /** p95 (ms) of each measured k6 run, in run order. */
  readonly p95Ms: readonly number[];
  /** Rows removed by filter in each warm EXPLAIN of the chosen plan, in run order. */
  readonly rowsRemoved: readonly number[];
  readonly limit: number;
}

export interface HistoryVerdict {
  readonly p95: Summary;
  readonly rowsRemoved: Summary;
  readonly rowsRemovedThreshold: number;
  readonly p95Exceeded: boolean;
  readonly rowsRemovedExceeded: boolean;
  readonly criterionMet: boolean;
}

export function historyVerdict(evidence: HistoryEvidence): HistoryVerdict {
  if (!Number.isSafeInteger(evidence.limit) || evidence.limit < 1) {
    throw new ProtocolError("history: the page limit must be a positive integer");
  }
  const p95 = summarize(evidence.p95Ms, "history p95", HISTORY_RUNS);
  const rowsRemoved = summarize(evidence.rowsRemoved, "rows removed", WARM_EXPLAIN_RUNS);
  const rowsRemovedThreshold = ROWS_REMOVED_FACTOR * evidence.limit;
  const p95Exceeded = p95.median > HISTORY_P95_LIMIT_MS;
  const rowsRemovedExceeded = rowsRemoved.median > rowsRemovedThreshold;
  return {
    p95,
    rowsRemoved,
    rowsRemovedThreshold,
    p95Exceeded,
    rowsRemovedExceeded,
    criterionMet: p95Exceeded || rowsRemovedExceeded,
  };
}

export interface AbRun {
  /** p95 (ms) of new consume requests in the measured phase. */
  readonly p95Ms: number;
  /** Validity of the run: invariants, thresholds and (for the hot gate) zero BUSY_RETRY. */
  readonly valid: boolean;
}

export interface GateEvidence {
  readonly workload: string;
  readonly baseline: readonly AbRun[];
  readonly candidate: readonly AbRun[];
}

export type GateOutcome = "pass" | "fail" | "inconclusive" | "invalid";

export interface GateVerdict {
  readonly workload: string;
  readonly baseline: Summary;
  readonly candidate: Summary;
  readonly regression: number;
  readonly outcome: GateOutcome;
  readonly reason: string;
}

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

export function gateVerdict(evidence: GateEvidence): GateVerdict {
  const { workload } = evidence;
  const baseline = summarize(
    evidence.baseline.map((run) => run.p95Ms),
    `${workload} baseline p95`,
    AB_RUNS_PER_VARIANT,
  );
  const candidate = summarize(
    evidence.candidate.map((run) => run.p95Ms),
    `${workload} candidate p95`,
    AB_RUNS_PER_VARIANT,
  );
  const change = regression(baseline, candidate);
  const verdict = (outcome: GateOutcome, reason: string): GateVerdict => ({
    workload,
    baseline,
    candidate,
    regression: change,
    outcome,
    reason,
  });
  if ([...evidence.baseline, ...evidence.candidate].some((run) => !run.valid)) {
    return verdict(
      "invalid",
      "at least one run was invalid (thresholds, invariants or BUSY_RETRY)",
    );
  }
  if (baseline.spread >= MAX_BASELINE_SPREAD) {
    return verdict(
      "inconclusive",
      `baseline p95 spread ${percent(baseline.spread)} is not below ${percent(MAX_BASELINE_SPREAD)}`,
    );
  }
  return change < MAX_REGRESSION
    ? verdict(
        "pass",
        `median p95 regression ${percent(change)} is below ${percent(MAX_REGRESSION)}`,
      )
    : verdict(
        "fail",
        `median p95 regression ${percent(change)} is not below ${percent(MAX_REGRESSION)}`,
      );
}

export interface IndexDecision {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/** The binding decision: S2 history criterion AND both consume gates passing. */
export function indexDecision(
  history: HistoryVerdict,
  gates: readonly GateVerdict[],
): IndexDecision {
  const required = ["distributed", "hot-account"];
  const names = gates.map((gate) => gate.workload).sort();
  if (names.join(",") !== [...required].sort().join(",")) {
    throw new ProtocolError(`index decision: gates must be exactly ${required.join(" and ")}`);
  }
  const reasons = [
    history.criterionMet
      ? `history criterion met (p95 ${history.p95.median.toFixed(2)} ms, rows removed ${String(history.rowsRemoved.median)})`
      : `history criterion not met (p95 ${history.p95.median.toFixed(2)} ms <= ${String(HISTORY_P95_LIMIT_MS)} ms and rows removed ${String(history.rowsRemoved.median)} <= ${String(history.rowsRemovedThreshold)})`,
    ...gates.map((gate) => `${gate.workload} gate ${gate.outcome}: ${gate.reason}`),
  ];
  return {
    eligible: history.criterionMet && gates.every((gate) => gate.outcome === "pass"),
    reasons,
  };
}
