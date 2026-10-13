import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/shared/logger.js";

function captureLogs(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("createLogger", () => {
  it("writes structured JSON with the service name and an ISO timestamp", () => {
    const output = captureLogs();

    createLogger("info", output).info({ port: 8080 }, "starting");

    const [line] = output.lines;
    const entry = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 30,
      service: "usage-metering-quota-service",
      port: 8080,
      msg: "starting",
    });
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("redacts credentials, connection strings and API-key headers", () => {
    const output = captureLogs();

    createLogger("info", output).info(
      {
        connectionString: "postgres://admin:hunter2@db/app",
        database: { password: "hunter2", host: "db" },
        req: { headers: { "x-api-key": "umqs_secret", authorization: "Bearer secret" } },
      },
      "sensitive",
    );

    const [line = ""] = output.lines;
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("umqs_secret");
    expect(line).not.toContain("Bearer secret");
    expect(line).toContain('"host":"db"');
    expect(line.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("respects the configured level", () => {
    const output = captureLogs();
    const logger = createLogger("warn", output);

    logger.info("hidden");
    logger.warn("shown");

    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).toContain("shown");
  });
});
