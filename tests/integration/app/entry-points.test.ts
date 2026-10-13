import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetTestDatabase,
  testDatabaseUrl,
  UNREACHABLE_DATABASE_URL,
  withTestClient,
} from "../../helpers/test-database.js";

// Runs the real process entry points (src/main.ts and src/db/migrate-cli.ts) as child processes,
// exactly as `npm run dev` / `npm run db:migrate` do, against the test database.

interface Output {
  stdout: string;
  stderr: string;
}

interface Completed extends Output {
  code: number | null;
}

let child: ChildProcess | undefined;

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(() => {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  child = undefined;
});

function launch(
  script: string,
  env: Record<string, string>,
): { output: Output; process: ChildProcess } {
  const output: Output = { stdout: "", stderr: "" };
  child = spawn(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString("utf8");
  });
  return { output, process: child };
}

function exitOf(running: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    running.once("exit", (code) => {
      resolve(code);
    });
  });
}

async function runToCompletion(script: string, env: Record<string, string>): Promise<Completed> {
  const { output, process: running } = launch(script, env);
  const code = await exitOf(running);
  return { ...output, code };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the child process");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

async function appliedMigrationCount(): Promise<number | undefined> {
  return withTestClient(async (client) => {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM schema_migrations",
    );
    return result.rows[0]?.count;
  });
}

describe("db:migrate CLI", () => {
  it("applies the migrations and exits 0", async () => {
    const result = await runToCompletion("src/db/migrate-cli.ts", {
      DATABASE_URL: testDatabaseUrl(),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("migrations applied");
    expect(result.stdout).not.toContain(passwordOf(testDatabaseUrl()));
    expect(await appliedMigrationCount()).toBe(2);
  });

  it("exits 1 when the database is unreachable, without leaking credentials", async () => {
    const result = await runToCompletion("src/db/migrate-cli.ts", {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      DB_CONNECTION_TIMEOUT_MS: "1000",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("migration failed");
    expect(result.stdout + result.stderr).not.toContain(passwordOf(UNREACHABLE_DATABASE_URL));
  });
});

describe("service entry point", () => {
  it("exits 1 and lists every configuration problem when the configuration is invalid", async () => {
    const result = await runToCompletion("src/main.ts", { DATABASE_URL: "", PORT: "70000" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PORT must be an integer between 1 and 65535");
    expect(result.stderr).toContain("DATABASE_URL is required");
  });

  it("exits 1 when startup cannot reach the database", async () => {
    const result = await runToCompletion("src/main.ts", {
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      DB_CONNECTION_TIMEOUT_MS: "1000",
      PORT: String(await freePort()),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("startup failed");
    expect(result.stdout + result.stderr).not.toContain(passwordOf(UNREACHABLE_DATABASE_URL));
  });

  // Windows cannot deliver a catchable SIGTERM to a child process, so this runs on Linux and
  // macOS (including CI); the Docker stop check covers the containerized path.
  it.skipIf(process.platform === "win32")(
    "migrates, serves traffic, then shuts down gracefully on SIGTERM",
    async () => {
      const port = await freePort();
      const { output, process: running } = launch("src/main.ts", {
        DATABASE_URL: testDatabaseUrl(),
        PORT: String(port),
      });
      const exited = exitOf(running);

      await waitFor(() => output.stdout.includes("Server listening"), 20_000);
      const ready = await fetch(`http://127.0.0.1:${String(port)}/health/ready`);
      running.kill("SIGTERM");
      const code = await exited;

      expect(ready.status).toBe(200);
      expect(code).toBe(0);
      expect(output.stdout).toContain('"signal":"SIGTERM"');
      expect(output.stdout).toContain("shutdown complete");
      expect(output.stdout + output.stderr).not.toContain(passwordOf(testDatabaseUrl()));
      expect(await appliedMigrationCount()).toBe(2);
    },
  );
});
