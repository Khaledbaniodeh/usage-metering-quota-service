import { describe, expect, it } from "vitest";
import {
  gateVerdict,
  historyVerdict,
  indexDecision,
  median,
  ProtocolError,
  regression,
  summarize,
  type AbRun,
  type GateVerdict,
} from "../../../load/lib/stats.js";

const runs = (...p95: number[]): AbRun[] => p95.map((p95Ms) => ({ p95Ms, valid: true }));

describe("median, range and spread", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it("keeps every value and reports range and relative spread", () => {
    expect(summarize([10, 12, 11])).toEqual({
      values: [10, 12, 11],
      median: 11,
      min: 10,
      max: 12,
      spread: 2 / 11,
    });
    expect(summarize([0, 0, 0]).spread).toBe(0);
  });

  it.each([
    ["no values", []],
    ["a negative value", [1, -1]],
    ["NaN", [1, Number.NaN]],
    ["Infinity", [1, Number.POSITIVE_INFINITY]],
  ])("rejects %s", (_label, values) => {
    expect(() => summarize(values)).toThrow(ProtocolError);
  });

  it("enforces the protocol's run count", () => {
    expect(() => summarize([1, 2], "history p95", 3)).toThrow(
      "history p95: the protocol requires exactly 3 values, got 2",
    );
  });
});

describe("regression", () => {
  it("is the relative change of the candidate median", () => {
    expect(regression(summarize([100, 100, 100]), summarize([104, 104, 104]))).toBeCloseTo(0.04);
    expect(regression(summarize([100]), summarize([90]))).toBeCloseTo(-0.1);
  });

  it("refuses a zero baseline", () => {
    expect(() => regression(summarize([0]), summarize([1]))).toThrow(ProtocolError);
  });
});

describe("history criterion", () => {
  const evidence = { p95Ms: [10, 12, 11], rowsRemoved: [5, 5, 5, 5, 5], limit: 20 };

  it("holds when the median p95 exceeds 50 ms", () => {
    const verdict = historyVerdict({ ...evidence, p95Ms: [49, 51, 52] });

    expect(verdict.p95.median).toBe(51);
    expect(verdict).toMatchObject({
      p95Exceeded: true,
      rowsRemovedExceeded: false,
      criterionMet: true,
    });
  });

  it("holds when the median rows removed exceed 100 × the limit (2,000 for 20)", () => {
    const verdict = historyVerdict({
      ...evidence,
      rowsRemoved: [2_001, 2_001, 1_999, 2_001, 1_000],
    });

    expect(verdict.rowsRemovedThreshold).toBe(2_000);
    expect(verdict).toMatchObject({ rowsRemovedExceeded: true, criterionMet: true });
  });

  it("does not hold at exactly the thresholds", () => {
    const verdict = historyVerdict({
      p95Ms: [50, 50, 50],
      rowsRemoved: [2_000, 2_000, 2_000, 2_000, 2_000],
      limit: 20,
    });

    expect(verdict.criterionMet).toBe(false);
  });

  it("uses the median, not the best or worst run", () => {
    expect(historyVerdict({ ...evidence, p95Ms: [10, 200, 12] }).criterionMet).toBe(false);
    expect(historyVerdict({ ...evidence, p95Ms: [60, 61, 1] }).criterionMet).toBe(true);
  });

  it("requires exactly 3 runs and 5 warm EXPLAINs", () => {
    expect(() => historyVerdict({ ...evidence, p95Ms: [1, 2] })).toThrow("exactly 3");
    expect(() => historyVerdict({ ...evidence, rowsRemoved: [1, 2, 3, 4, 5, 6] })).toThrow(
      "exactly 5",
    );
    expect(() => historyVerdict({ ...evidence, limit: 0 })).toThrow("positive integer");
  });
});

describe("consume gates", () => {
  const gate = (baseline: AbRun[], candidate: AbRun[]) =>
    gateVerdict({ workload: "distributed", baseline, candidate });

  it("passes below 5% median regression", () => {
    const verdict = gate(runs(100, 101, 100, 102, 100), runs(104, 104, 103, 105, 104));

    expect(verdict.outcome).toBe("pass");
    expect(verdict.regression).toBeCloseTo(0.04);
  });

  it("fails at exactly 5% and above", () => {
    expect(gate(runs(100, 100, 100, 100, 100), runs(105, 105, 105, 105, 105)).outcome).toBe("fail");
    expect(gate(runs(100, 100, 100, 100, 100), runs(110, 108, 109, 110, 111)).outcome).toBe("fail");
  });

  it("is inconclusive when the baseline spread reaches 5%, whatever the regression", () => {
    const verdict = gate(runs(100, 105, 100, 100, 100), runs(90, 90, 90, 90, 90));

    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reason).toBe("baseline p95 spread 5.00% is not below 5.00%");
  });

  it("is invalid when any run broke its validity conditions", () => {
    const candidate = runs(100, 100, 100, 100, 100);
    candidate[2] = { p95Ms: 100, valid: false };

    expect(gate(runs(100, 100, 100, 100, 100), candidate).outcome).toBe("invalid");
  });

  it("requires exactly 5 predetermined runs per variant", () => {
    expect(() => gate(runs(100, 100, 100, 100), runs(100, 100, 100, 100, 100))).toThrow(
      "exactly 5",
    );
    expect(() => gate(runs(100, 100, 100, 100, 100), runs(1, 1, 1, 1, 1, 1))).toThrow("exactly 5");
  });
});

describe("index decision", () => {
  const history = (met: boolean) =>
    historyVerdict({
      p95Ms: met ? [60, 60, 60] : [10, 10, 10],
      rowsRemoved: [0, 0, 0, 0, 0],
      limit: 20,
    });
  const verdict = (workload: string, outcome: GateVerdict["outcome"]): GateVerdict => ({
    ...gateVerdict({
      workload,
      baseline: runs(100, 100, 100, 100, 100),
      candidate: runs(101, 101, 101, 101, 101),
    }),
    outcome,
  });

  it("is eligible only when the history criterion holds and both gates pass", () => {
    expect(
      indexDecision(history(true), [verdict("distributed", "pass"), verdict("hot-account", "pass")])
        .eligible,
    ).toBe(true);
    expect(
      indexDecision(history(false), [
        verdict("distributed", "pass"),
        verdict("hot-account", "pass"),
      ]).eligible,
    ).toBe(false);
  });

  it.each(["fail", "inconclusive", "invalid"] as const)(
    "is not eligible when one gate is %s",
    (outcome) => {
      const decision = indexDecision(history(true), [
        verdict("distributed", "pass"),
        verdict("hot-account", outcome),
      ]);

      expect(decision.eligible).toBe(false);
      expect(
        decision.reasons.some((reason) => reason.startsWith(`hot-account gate ${outcome}`)),
      ).toBe(true);
    },
  );

  it("requires exactly the distributed and hot-account gates", () => {
    expect(() => indexDecision(history(true), [verdict("distributed", "pass")])).toThrow(
      ProtocolError,
    );
    expect(() =>
      indexDecision(history(true), [verdict("distributed", "pass"), verdict("contention", "pass")]),
    ).toThrow(ProtocolError);
  });
});
