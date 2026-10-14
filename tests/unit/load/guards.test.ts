import { describe, expect, it } from "vitest";
import { BenchDatabaseError, benchDatabase } from "../../../load/lib/bench-db.js";
import {
  buildEnvironmentRecord,
  EnvironmentError,
  RECORDED_SETTINGS,
  type EnvironmentInput,
} from "../../../load/lib/environment.js";
import { firstHistoryPageQuery } from "../../../load/lib/history-query.js";

const URL_OK = "postgres://usage_metering:ci-bench-only@127.0.0.1:15432/usage_metering_bench";

describe("benchDatabase", () => {
  it("accepts a loopback _bench database and exposes its password for redaction", () => {
    expect(benchDatabase({ BENCH_DATABASE_URL: URL_OK })).toEqual({
      url: URL_OK,
      databaseName: "usage_metering_bench",
      password: "ci-bench-only",
    });
    expect(benchDatabase({ BENCH_DATABASE_URL: "postgresql://u@localhost/x_bench" }).password).toBe(
      "",
    );
  });

  it.each([
    ["missing", undefined, "is required"],
    ["not a URL", "nonsense", "must be a postgres:// URL"],
    ["another protocol", "mysql://u:p@127.0.0.1/a_bench", "must be a postgres:// URL"],
    ["a remote host", "postgres://u:p@db.example.com/a_bench", "loopback"],
    ["the development database", "postgres://u:p@localhost:5432/usage_metering", 'end in "_bench"'],
    ["the test database", "postgres://u:p@localhost:5432/usage_metering_test", 'end in "_bench"'],
    ["an upper-case name", "postgres://u:p@localhost/USAGE_BENCH", 'end in "_bench"'],
    ["an injected name", "postgres://u:p@localhost/x;drop_bench", 'end in "_bench"'],
  ])("refuses %s without echoing the URL", (_label, url, message) => {
    const attempt = () => benchDatabase({ BENCH_DATABASE_URL: url });

    expect(attempt).toThrow(BenchDatabaseError);
    expect(attempt).toThrow(message);
    try {
      attempt();
    } catch (error) {
      expect(String(error)).not.toMatch(/:p@|example\.com/);
    }
  });
});

describe("buildEnvironmentRecord", () => {
  const input: EnvironmentInput = {
    commitSha: "a".repeat(40),
    profile: "smoke",
    shape: "s2",
    node: "v22.23.3",
    platform: "linux 6.8",
    cpuModel: "AMD EPYC 7763",
    cpuCount: 4,
    totalMemoryBytes: 16 * 1024 ** 3,
    images: { k6: { reference: "grafana/k6:2.3.0", digest: `sha256:${"9".repeat(64)}` } },
    tools: { k6: "k6 v2.3.0" },
    limits: { api: { nanoCpus: 1e9, memoryBytes: 512 * 1024 ** 2 } },
    database: {
      version: "PostgreSQL 16.15",
      settings: Object.fromEntries(RECORDED_SETTINGS.map((name) => [name, "x"])),
    },
  };

  it("stamps a schema and time onto a complete record", () => {
    const record = buildEnvironmentRecord(input, new Date("2026-10-15T00:00:00Z"));

    expect(record.schema).toBe("umqs-bench-environment/1");
    expect(record.recordedAt).toBe("2026-10-15T00:00:00.000Z");
  });

  it.each([
    ["a short commit SHA", { commitSha: "abc123" }],
    [
      "an image without a digest",
      { images: { k6: { reference: "grafana/k6:2.3.0", digest: "2.3.0" } } },
    ],
    [
      "an image without a reference",
      { images: { k6: { reference: " ", digest: `sha256:${"0".repeat(64)}` } } },
    ],
    ["no CPU", { cpuCount: 0 }],
    ["an unlimited container", { limits: { api: { nanoCpus: 0, memoryBytes: 1 } } }],
    ["missing settings", { database: { version: "x", settings: {} } }],
  ])("refuses %s", (_label, change) => {
    expect(() => buildEnvironmentRecord({ ...input, ...change }, new Date())).toThrow(
      EnvironmentError,
    );
  });
});

describe("firstHistoryPageQuery", () => {
  it("captures the statement production sends for a user-and-month first page", async () => {
    const query = await firstHistoryPageQuery(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "2025-01",
      20,
    );

    expect(query.sql).toMatch(
      /FROM consume_decisions\s+WHERE account_id = \$1 AND user_id = \$2 AND month = \$3\s+ORDER BY seq DESC\s+LIMIT \$4$/,
    );
    expect(query.params).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "2025-01-01",
      21,
    ]);
  });
});
