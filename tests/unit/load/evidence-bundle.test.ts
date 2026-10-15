import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEvidenceDirectoryFree,
  buildEvidenceBundle,
  EvidenceError,
  expectedRunLabels,
  missingEvidence,
  type EvidenceMode,
} from "../../../load/lib/evidence-bundle.js";
import { findSecrets } from "../../../load/lib/redact.js";

const SHA = "0".repeat(40);
const stats = (p95: number) => ({
  count: 100,
  min: 1,
  med: 2,
  avg: 2,
  p90: 3,
  p95,
  p99: p95,
  max: p95,
});

/** A k6 summary in the exact shape load/k6/lib.js writes. */
function k6Summary(runLabel: string, p95: number, workload = "distributed") {
  return {
    schema: "umqs-bench-k6/1",
    workload,
    runLabel,
    gating: true,
    thresholdsPassed: true,
    measured: {
      iterations: 600,
      droppedIterations: 0,
      httpRequests: 600,
      httpFailedRate: 0,
      checksRate: 1,
      primaryKind: "new",
      primaryDurationMs: stats(p95),
      outcomes: {
        ok: 600,
        accepted: 570,
        rejected: 30,
        busyRetry: 0,
        conflict: 0,
        unexpected: 0,
        replayMatch: 60,
        replayMismatch: 0,
        batchBad: 0,
      },
    },
    stages: [
      {
        name: "measure-1",
        rate: 5,
        seconds: 120,
        offeredIterations: 600,
        achievedIterations: 600,
        droppedIterations: 0,
        primaryDurationMs: stats(p95),
      },
    ],
    manifest: {
      requestIdPrefix: `${runLabel}.`,
      expectedDecisions: 750,
      expectedAccepted: 712,
      batchesOk: 0,
      batchesBad: 0,
    },
  };
}

const warm = {
  planningMs: 0.1,
  executionMs: 0.05,
  actualRows: 21,
  rowsRemovedByFilter: 4,
  rowsRemovedByIndexRecheck: 0,
  sharedHitBlocks: 4,
  sharedReadBlocks: 0,
  indexes: ["i"],
  scans: ["Index Scan Backward on i"],
  sorts: false,
};

/** An in-memory results directory. */
function source(files: Record<string, unknown>) {
  const map = new Map(Object.entries(files));
  const text = (name: string) => {
    const value = map.get(name);
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return {
    names: [...map.keys()],
    readText: text,
    readJson: (name: string) => JSON.parse(text(name)) as unknown,
  };
}

function build(
  files: Record<string, unknown>,
  mode: EvidenceMode,
  profile: "smoke" | "full" = "full",
  secrets: string[] = [],
) {
  return buildEvidenceBundle({
    profile,
    commitSha: SHA,
    mode,
    source: source(files),
    secrets,
    now: new Date("2026-10-15T00:00:00Z"),
  });
}

const summaryOf = (bundle: ReturnType<typeof build>) =>
  JSON.parse(bundle.files.get("summary.json") ?? "{}") as Record<string, unknown>;

/** The results of a full run that stopped after the history runs and the first gate pair. */
function stoppedEarly(): Record<string, unknown> {
  return {
    "environment.json": { schema: "umqs-bench-environment/1", commitSha: SHA },
    "seed.json": { counts: { decisions: 1_498_000 } },
    "explain-s2-a.json": {
      label: "s2-a",
      query: {},
      firstAfterRestart: warm,
      warm: [warm, warm, warm, warm, warm],
    },
    "explain-s2-a.txt": "Limit (actual rows=21)\n",
    "invariants-after-seed.json": { label: "after-seed", passed: true, violations: {} },
    "k6-hist-s2-a-1.json": k6Summary("hist-s2-a-1", 2.3, "history"),
    "k6-hist-s2-a-2.json": k6Summary("hist-s2-a-2", 2.18, "history"),
    "k6-hist-s2-a-3.json": k6Summary("hist-s2-a-3", 2.07, "history"),
    "k6-ab-dist-a-1.json": k6Summary("ab-dist-a-1", 5.07),
    "invariants-ab-dist-a-1.json": { label: "ab-dist-a-1", passed: true, violations: {} },
    "k6-exit-ab-dist-a-1.txt": "0\n",
    "k6-ab-hot-a-1.json": k6Summary("ab-hot-a-1", 5.81, "hot-account"),
    "k6-exit-ab-hot-a-1.txt": "124\n",
  };
}

describe("expected evidence", () => {
  it("lists every run of a profile", () => {
    expect(expectedRunLabels("smoke")).toEqual({
      history: ["hist-s2-a-1"],
      gates: ["ab-dist-a-1", "ab-hot-a-1"],
      diagnostics: ["diag-spread", "diag-account", "diag-user"],
      races: ["race-identical", "race-conflicting"],
    });
    const full = expectedRunLabels("full");
    expect(full.history).toHaveLength(3);
    expect(full.gates).toHaveLength(10);
  });

  it("names the missing runs, including diagnostics and races, and the missing files", () => {
    const missing = missingEvidence("full", Object.keys(stoppedEarly()));

    expect(missing.runLabels).toEqual([
      "ab-dist-a-2",
      "ab-hot-a-2",
      "ab-dist-a-3",
      "ab-hot-a-3",
      "ab-dist-a-4",
      "ab-hot-a-4",
      "ab-dist-a-5",
      "ab-hot-a-5",
      "diag-spread",
      "diag-account",
      "diag-user",
      "race-identical",
      "race-conflicting",
    ]);
    expect(missing.files).toEqual(
      expect.arrayContaining([
        "footprint-after-workloads.json",
        "disk-projection.json",
        "invariants-ab-hot-a-1.json",
        "k6-diag-spread.json",
        "invariants-race-conflicting.json",
      ]),
    );
    expect(missing.files).not.toContain("k6-ab-dist-a-1.json");
  });
});

describe("partial evidence", () => {
  it("marks the bundle incomplete, keeps what exists and computes no decision", () => {
    const bundle = build(stoppedEarly(), "partial");
    const summary = summaryOf(bundle);

    expect(bundle.complete).toBe(false);
    expect(summary).toMatchObject({
      schema: "umqs-bench-evidence/1",
      complete: false,
      benchmarkStepFailed: true,
      commitSha: SHA,
      profile: "full",
      k6ExitCodes: { "ab-dist-a-1": 0, "ab-hot-a-1": 124 },
      decision: { computed: false },
    });
    expect((summary.k6Runs as unknown[]).length).toBe(5);
    expect((summary.decision as { reason: string }).reason).toMatch(
      /no performance or index conclusion/,
    );
    expect([...bundle.files.keys()].sort()).toEqual([
      "decision.md",
      "environment.json",
      "explain-s2-a.txt",
      "summary.json",
    ]);
  });

  it("states the failure and every missing run in decision.md, without a classification", () => {
    const table = build(stoppedEarly(), "partial").files.get("decision.md") ?? "";

    expect(table).toMatch(/^# Benchmark evidence \(full\): INCOMPLETE/);
    expect(table).toContain("**The benchmark step failed.**");
    expect(table).toContain(
      "diag-spread, diag-account, diag-user, race-identical, race-conflicting",
    );
    expect(table).not.toMatch(/Eligible:/);
  });

  it("never computes a decision, even when every decision input happens to exist", () => {
    const files: Record<string, unknown> = { ...stoppedEarly() };
    for (const prefix of ["ab-dist-a", "ab-dist-b", "ab-hot-a", "ab-hot-b"]) {
      for (let run = 1; run <= 5; run += 1) {
        files[`k6-${prefix}-${String(run)}.json`] = k6Summary(`${prefix}-${String(run)}`, 5);
        files[`invariants-${prefix}-${String(run)}.json`] = {
          label: `${prefix}-${String(run)}`,
          passed: true,
          violations: {},
        };
      }
    }

    expect(build(files, "complete").decision.computed).toBe(true);
    expect(build(files, "partial").decision.computed).toBe(false);
  });

  it("records a malformed result file instead of aborting", () => {
    const files = {
      ...stoppedEarly(),
      "k6-ab-hot-a-1.json": { schema: "umqs-bench-k6/1", runLabel: "ab-hot-a-1" },
      "seed.json": "{not json",
    };

    const summary = summaryOf(build(files, "partial"));

    expect((summary.invalidFiles as { file: string }[]).map((f) => f.file).sort()).toEqual([
      "k6-ab-hot-a-1.json",
      "seed.json",
    ]);
    expect(summary.seed).toBeNull();
  });

  it("keeps complete mode strict: a malformed summary fails the report", () => {
    const files = { ...stoppedEarly(), "k6-ab-hot-a-1.json": { schema: "umqs-bench-k6/1" } };

    expect(() => build(files, "complete")).toThrow();
  });

  it("redacts keys and literal secrets, and the result passes the scan", () => {
    const key = `umqs_${randomBytes(32).toString("base64url")}`;
    const password = "0123456789abcdef0123456789abcdef";
    const files = {
      ...stoppedEarly(),
      "explain-s2-a.txt": `Filter: (x = '${key}')\nurl postgres://usage_metering:${password}@127.0.0.1:15432/usage_metering_bench\n`,
      "environment.json": { note: `password ${password}` },
    };

    const bundle = build(files, "partial", "full", [password]);
    const all = [...bundle.files.values()].join("\n");

    expect(all).not.toContain(key);
    expect(all).not.toContain(password);
    expect(findSecrets(all, [password])).toEqual([]);
  });

  it("keeps the successful format: complete bundles are marked complete", () => {
    const summary = summaryOf(build(stoppedEarly(), "complete", "full"));

    expect(summary).toMatchObject({
      complete: true,
      benchmarkStepFailed: false,
      schema: "umqs-bench-evidence/1",
    });
    expect(summary).toHaveProperty("k6Runs");
    expect(summary).toHaveProperty("decision");
  });
});

describe("assertEvidenceDirectoryFree", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), "umqs-evidence-"));
    made.push(dir);
    return dir;
  };

  it("accepts a directory that does not exist yet, or is empty", () => {
    const dir = temp();

    expect(() => {
      assertEvidenceDirectoryFree(join(dir, "evidence"));
    }).not.toThrow();
    mkdirSync(join(dir, "empty"));
    expect(() => {
      assertEvidenceDirectoryFree(join(dir, "empty"));
    }).not.toThrow();
  });

  it("refuses to overwrite an existing evidence bundle", () => {
    const dir = temp();
    writeFileSync(join(dir, "summary.json"), "{}");

    expect(() => {
      assertEvidenceDirectoryFree(dir);
    }).toThrow(EvidenceError);
  });
});
