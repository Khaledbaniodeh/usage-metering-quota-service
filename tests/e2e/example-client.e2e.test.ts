import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { redactApiKeys } from "../../client/api-key.js";

/**
 * Runs the real example client (`client/main.ts`) as a separate process against the running
 * service, exactly as `npm run client:example` does, and checks its exit code and output.
 */

const STEPS = [
  "health",
  "create account",
  "create users",
  "find the predefined user plans",
  "switch user 2 to Premium",
  "users on different plans",
  "accepted request",
  "idempotent retry",
  "user-limit rejection",
  "Premium user allowed the same amount",
  "create a shared account plan",
  "assign it to the account",
  "account-limit rejection",
  "raise the shared plan",
  "accepted after the plan update",
  "account usage",
  "user usage",
  "walk GET /v1/users",
  "walk GET /v1/usage/users",
  "walk GET /v1/history",
];

/** Anything shaped like an API key, including a partial one. */
const KEY_LIKE = /umqs_[A-Za-z0-9_-]{8,}/;

interface ClientRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runExampleClient(): Promise<ClientRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "client/main.ts"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("example client against the running service", () => {
  it("completes the whole workflow and never prints an API key", async () => {
    const run = await runExampleClient();

    // Checked before anything is printed, so a leaked key never reaches the CI log.
    const leaked = KEY_LIKE.test(run.stdout) || KEY_LIKE.test(run.stderr);
    // The client's own output, redacted again for safety, shows what was exercised.
    process.stdout.write(redactApiKeys(run.stdout));
    process.stderr.write(redactApiKeys(run.stderr));

    expect(leaked, "an API-key-shaped value appeared in the client output").toBe(false);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    for (const step of STEPS) {
      expect(run.stdout).toContain(`[ok] ${step}: `);
    }
    expect(run.stdout).toMatch(
      /^Example workflow passed: account [0-9a-f-]{36}, month \d{4}-\d{2}, 3 users, 3 accepted and 2 rejected decisions, 40 units used; walked 3\/3\/5 pages \(users\/usage\/history\)\.$/m,
    );
  });
});
