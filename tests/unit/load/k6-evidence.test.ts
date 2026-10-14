import { describe, expect, it } from "vitest";
import { assembleDecision } from "../../../load/lib/evidence.js";
import type { ExplainSummary } from "../../../load/lib/explain.js";
import {
  K6SummaryError,
  manifestChecks,
  parseK6Summary,
  type K6Summary,
} from "../../../load/lib/k6-summary.js";

const stats = (p95: number) => ({
  count: 100,
  min: 1,
  med: p95 / 2,
  avg: p95 / 2,
  p90: p95 * 0.9,
  p95,
  p99: p95 * 1.2,
  max: p95 * 2,
});

/** A summary in the exact shape load/k6/lib.js writes. */
function summary(runLabel: string, p95: number, overrides: Record<string, unknown> = {}) {
  return {
    schema: "umqs-bench-k6/1",
    workload: "distributed",
    runLabel,
    gating: true,
    config: { accounts: 50 },
    testRunDurationMs: 150_000,
    thresholdsPassed: true,
    measured: {
      iterations: 6_000,
      droppedIterations: 0,
      httpRequests: 6_600,
      httpFailedRate: 0,
      checksRate: 1,
      requestDurationMs: stats(p95),
      primaryKind: "new",
      primaryDurationMs: stats(p95),
      outcomes: {
        ok: 6_000,
        accepted: 5_700,
        rejected: 300,
        busyRetry: 0,
        conflict: 0,
        unexpected: 0,
        replayMatch: 600,
        replayMismatch: 0,
        batchBad: 0,
      },
    },
    stages: [
      {
        name: "measure-1",
        rate: 50,
        seconds: 120,
        offeredIterations: 6_000,
        achievedIterations: 6_000,
        droppedIterations: 0,
        primaryDurationMs: stats(p95),
      },
    ],
    manifest: {
      requestIdPrefix: `${runLabel}.`,
      expectedDecisions: 7_500,
      expectedAccepted: 7_125,
      batchesOk: 0,
      batchesBad: 0,
    },
    ...overrides,
  };
}

describe("parseK6Summary", () => {
  it("accepts the schema written by the k6 helpers", () => {
    const parsed = parseK6Summary(summary("ab-dist-a-1", 12));

    expect(parsed.measured.primaryDurationMs?.p95).toBe(12);
    expect(parsed.stages[0]?.offeredIterations).toBe(6_000);
    expect(parsed.manifest.expectedDecisions).toBe(7_500);
  });

  it("accepts null latency when nothing of the primary kind was measured", () => {
    const run = summary("smoke-1", 1);
    run.measured.primaryDurationMs = null as unknown as ReturnType<typeof stats>;

    expect(parseK6Summary(run).measured.primaryDurationMs).toBeNull();
  });

  it.each([
    ["another schema", { schema: "umqs-bench-k6/2" }],
    ["an unsafe run label", { runLabel: "../etc" }],
    ["a missing manifest", { manifest: undefined }],
    [
      "a mismatched request-ID prefix",
      {
        manifest: {
          requestIdPrefix: "other.",
          expectedDecisions: 0,
          expectedAccepted: 0,
          batchesOk: 0,
          batchesBad: 0,
        },
      },
    ],
    ["no stages", { stages: [] }],
    ["a non-boolean threshold result", { thresholdsPassed: "yes" }],
  ])("rejects %s", (_label, change) => {
    expect(() => parseK6Summary(JSON.parse(JSON.stringify(summary("run-1", 5, change))))).toThrow(
      K6SummaryError,
    );
  });

  it("rejects negative counts and out-of-range rates", () => {
    const negative = summary("run-1", 5);
    negative.measured.outcomes.accepted = -1;
    const rate = summary("run-1", 5);
    rate.measured.httpFailedRate = 2;

    expect(() => parseK6Summary(negative)).toThrow("measured.outcomes.accepted");
    expect(() => parseK6Summary(rate)).toThrow("httpFailedRate");
  });
});

describe("manifestChecks", () => {
  const manifest = parseK6Summary(summary("run-1", 5)).manifest;

  it("passes when the stored decisions match what k6 caused", () => {
    expect(manifestChecks(manifest, { total: 7_500, accepted: 7_125 }).every((c) => c.passed)).toBe(
      true,
    );
  });

  it("fails on a lost or duplicated decision, a miscounted acceptance or a bad race batch", () => {
    expect(manifestChecks(manifest, { total: 7_499, accepted: 7_125 })[0]?.passed).toBe(false);
    expect(manifestChecks(manifest, { total: 7_500, accepted: 7_126 })[1]?.passed).toBe(false);
    expect(
      manifestChecks({ ...manifest, batchesBad: 1 }, { total: 7_500, accepted: 7_125 })[2]?.passed,
    ).toBe(false);
  });
});

describe("assembleDecision", () => {
  const warm = (rows: number): ExplainSummary => ({
    planningMs: 0.2,
    executionMs: 1,
    actualRows: 21,
    rowsRemovedByFilter: rows,
    rowsRemovedByIndexRecheck: 0,
    sharedHitBlocks: 10,
    sharedReadBlocks: 0,
    indexes: ["i"],
    scans: ["Index Scan on i"],
    sorts: false,
  });
  const runsFor = (prefix: string, count: number, p95: number) =>
    Array.from({ length: count }, (_u, i) =>
      parseK6Summary(summary(`${prefix}-${String(i + 1)}`, p95)),
    );
  const complete = (hotCandidateP95 = 10.2): K6Summary[] => [
    ...runsFor("hist-s2-a", 3, 80),
    ...runsFor("ab-dist-a", 5, 10),
    ...runsFor("ab-dist-b", 5, 10.2),
    ...runsFor("ab-hot-a", 5, 10),
    ...runsFor("ab-hot-b", 5, hotCandidateP95),
  ];
  const allPassed = (runs: K6Summary[]) => Object.fromEntries(runs.map((r) => [r.runLabel, true]));
  const explains = { "s2-a": { warm: [1, 1, 1, 1, 1].map(warm) } };

  it("never decides on the smoke profile", () => {
    const runs = complete();

    expect(
      assembleDecision({ profile: "smoke", k6: runs, explains, invariantsPassed: allPassed(runs) }),
    ).toEqual({
      computed: false,
      reason: "profile smoke: pipeline validation only, no performance conclusion",
      missing: [],
    });
  });

  it("names every missing run instead of deciding on partial evidence", () => {
    const runs = complete().filter((r) => r.runLabel !== "ab-hot-b-5");
    const report = assembleDecision({
      profile: "full",
      k6: runs,
      explains: {},
      invariantsPassed: allPassed(runs),
    });

    expect(report).toEqual({
      computed: false,
      reason: "required runs are missing",
      missing: ["ab-hot-b-5", "explain s2-a"],
    });
  });

  it("decides eligible when the history criterion holds and both gates pass", () => {
    const runs = complete();
    const report = assembleDecision({
      profile: "full",
      k6: runs,
      explains,
      invariantsPassed: allPassed(runs),
    });

    expect(report.computed && report.decision.eligible).toBe(true);
  });

  it("is not eligible when the hot-account gate regresses 5% or more", () => {
    const runs = complete(10.5);
    const report = assembleDecision({
      profile: "full",
      k6: runs,
      explains,
      invariantsPassed: allPassed(runs),
    });

    expect(report.computed && report.decision.eligible).toBe(false);
  });

  it("treats a run whose invariants failed, or a hot run with BUSY_RETRY, as invalid", () => {
    const runs = complete();
    const failedInvariants = { ...allPassed(runs), "ab-dist-b-3": false };
    const busy = runs.map((r) =>
      r.runLabel === "ab-hot-a-2"
        ? parseK6Summary({
            ...summary(r.runLabel, 10),
            measured: {
              ...summary(r.runLabel, 10).measured,
              outcomes: { ...summary(r.runLabel, 10).measured.outcomes, busyRetry: 1 },
            },
          })
        : r,
    );

    const first = assembleDecision({
      profile: "full",
      k6: runs,
      explains,
      invariantsPassed: failedInvariants,
    });
    const second = assembleDecision({
      profile: "full",
      k6: busy,
      explains,
      invariantsPassed: allPassed(runs),
    });

    expect(
      first.computed &&
        first.decision.reasons.some((r) => r.startsWith("distributed gate invalid")),
    ).toBe(true);
    expect(
      second.computed &&
        second.decision.reasons.some((r) => r.startsWith("hot-account gate invalid")),
    ).toBe(true);
  });
});
