import type { ExplainSummary } from "./explain.js";
import type { K6Summary } from "./k6-summary.js";
import { HISTORY_PAGE_LIMIT } from "./profiles.js";
import {
  AB_RUNS_PER_VARIANT,
  gateVerdict,
  HISTORY_RUNS,
  historyVerdict,
  indexDecision,
  type AbRun,
  type IndexDecision,
} from "./stats.js";

/**
 * Assembles the approved decision from labelled runs. Run labels follow one convention:
 *
 *   hist-s2-a-<1..3>       measured history runs on the S2 baseline (variant a)
 *   explain set "s2-a"     first-after-restart + 5 warm EXPLAINs on the S2 baseline
 *   ab-dist-<a|b>-<1..5>   distributed consume gate, baseline (a) and candidate (b)
 *   ab-hot-<a|b>-<1..5>    unsaturated hot-account consume gate
 *
 * Only the full profile can decide; S3 labels never enter the decision.
 */

export interface DecisionInputs {
  readonly profile: string;
  readonly k6: readonly K6Summary[];
  readonly explains: Readonly<Record<string, { readonly warm: readonly ExplainSummary[] }>>;
  /** Invariant results per run label (true = every invariant and manifest check held). */
  readonly invariantsPassed: Readonly<Record<string, boolean>>;
}

export type DecisionReport =
  | { readonly computed: true; readonly decision: IndexDecision }
  | { readonly computed: false; readonly reason: string; readonly missing: readonly string[] };

function labels(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index + 1)}`);
}

export function assembleDecision(inputs: DecisionInputs): DecisionReport {
  if (inputs.profile !== "full") {
    return {
      computed: false,
      reason: `profile ${inputs.profile}: pipeline validation only, no performance conclusion`,
      missing: [],
    };
  }
  const byLabel = new Map(inputs.k6.map((run) => [run.runLabel, run]));
  const invariants = new Map(Object.entries(inputs.invariantsPassed));
  const required = [
    ...labels("hist-s2-a", HISTORY_RUNS),
    ...["ab-dist-a", "ab-dist-b", "ab-hot-a", "ab-hot-b"].flatMap((prefix) =>
      labels(prefix, AB_RUNS_PER_VARIANT),
    ),
  ];
  const explain = new Map(Object.entries(inputs.explains)).get("s2-a");
  const missing = [
    ...required.filter((label) => !byLabel.has(label)),
    ...(explain === undefined ? ["explain s2-a"] : []),
  ];
  if (missing.length > 0 || explain === undefined) {
    return { computed: false, reason: "required runs are missing", missing };
  }

  const p95 = (label: string) => byLabel.get(label)?.measured.primaryDurationMs?.p95 ?? Number.NaN;
  const history = historyVerdict({
    p95Ms: labels("hist-s2-a", HISTORY_RUNS).map(p95),
    rowsRemoved: explain.warm.map((plan) => plan.rowsRemovedByFilter),
    limit: HISTORY_PAGE_LIMIT,
  });
  const abRuns = (prefix: string, requireNoBusy: boolean): AbRun[] =>
    labels(prefix, AB_RUNS_PER_VARIANT).map((label) => {
      const run = byLabel.get(label);
      const valid =
        run !== undefined &&
        run.thresholdsPassed &&
        run.measured.droppedIterations === 0 &&
        run.measured.outcomes.unexpected === 0 &&
        (!requireNoBusy || run.measured.outcomes.busyRetry === 0) &&
        invariants.get(label) === true;
      return { p95Ms: p95(label), valid };
    });
  const gates = [
    gateVerdict({
      workload: "distributed",
      baseline: abRuns("ab-dist-a", false),
      candidate: abRuns("ab-dist-b", false),
    }),
    gateVerdict({
      workload: "hot-account",
      baseline: abRuns("ab-hot-a", true),
      candidate: abRuns("ab-hot-b", true),
    }),
  ];
  return { computed: true, decision: indexDecision(history, gates) };
}
