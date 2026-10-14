import { describe, expect, it } from "vitest";
import { ExplainFormatError, summarizeExplain } from "../../../load/lib/explain.js";

/** A realistic EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) result: Limit over a backward index scan. */
function plan(overrides: { scan?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  return [
    {
      Plan: {
        "Node Type": "Limit",
        "Actual Rows": 21,
        "Actual Loops": 1,
        "Shared Hit Blocks": 812,
        "Shared Read Blocks": 37,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Scan Direction": "Backward",
            "Index Name": "consume_decisions_account_month_seq_idx",
            "Actual Rows": 21,
            "Actual Loops": 1,
            "Rows Removed by Filter": 4,
            ...overrides.scan,
          },
        ],
      },
      "Planning Time": 0.412,
      "Execution Time": 1.87,
      Settings: {},
      ...overrides.top,
    },
  ];
}

describe("summarizeExplain", () => {
  it("extracts timings, rows, buffers, the chosen index and scan direction", () => {
    expect(summarizeExplain(plan())).toEqual({
      planningMs: 0.412,
      executionMs: 1.87,
      actualRows: 21,
      rowsRemovedByFilter: 4,
      rowsRemovedByIndexRecheck: 0,
      sharedHitBlocks: 812,
      sharedReadBlocks: 37,
      indexes: ["consume_decisions_account_month_seq_idx"],
      scans: ["Index Scan Backward on consume_decisions_account_month_seq_idx"],
      sorts: false,
    });
  });

  it("multiplies per-loop rows removed by the loop count", () => {
    const summary = summarizeExplain(
      plan({ scan: { "Actual Loops": 3, "Rows Removed by Filter": 1_000 } }),
    );

    expect(summary.rowsRemovedByFilter).toBe(3_000);
  });

  it("detects a sort anywhere in the plan", () => {
    const sorted = plan({
      scan: {
        "Node Type": "Sort",
        "Index Name": undefined,
        Plans: [
          {
            "Node Type": "Bitmap Heap Scan",
            "Actual Rows": 50,
            "Actual Loops": 1,
            "Rows Removed by Index Recheck": 7,
          },
        ],
      },
    });

    const summary = summarizeExplain(JSON.parse(JSON.stringify(sorted)));

    expect(summary.sorts).toBe(true);
    expect(summary.indexes).toEqual([]);
    expect(summary.rowsRemovedByIndexRecheck).toBe(7);
  });

  it.each([
    ["not an array", { Plan: {} }],
    ["an empty array", []],
    ["two results", [plan()[0], plan()[0]]],
    ["no Plan", [{ "Planning Time": 1 }]],
    ["a missing execution time", plan({ top: { "Execution Time": undefined } })],
    ["a negative time", plan({ top: { "Planning Time": -1 } })],
    ["a node without a type", plan({ scan: { "Node Type": 7 } })],
    ["a node without loops", plan({ scan: { "Actual Loops": undefined } })],
    ["malformed children", plan({ scan: { Plans: "x" } })],
    ["a string rows-removed value", plan({ scan: { "Rows Removed by Filter": "4" } })],
  ])("rejects %s instead of reading zeros", (_label, output) => {
    expect(() => summarizeExplain(JSON.parse(JSON.stringify(output)))).toThrow(ExplainFormatError);
  });
});
