import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactApiKeys } from "../../client/api-key.js";

/**
 * Checks one complete run of the example client against the real service, from its output and
 * exit code. The run is either
 *
 * - the Compose `client` service's run: CI sets CLIENT_LOG to its captured log and
 *   CLIENT_EXIT_CODE to its container's exit code; or
 * - otherwise, `client/main.ts` started here as a separate process against API_BASE_URL (default
 *   http://127.0.0.1:8080), exactly as `npm run client:example` does.
 *
 * The output must show every required behavior, with the predefined plans' arithmetic.
 */

/** Every step, in order. */
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

/** The evidence of each required behavior, as printed; request IDs start with the run's ID. */
const EVIDENCE: readonly [string, RegExp][] = [
  [
    "users of one account on different plans",
    /^\[ok\] users on different plans: user 1 on Basic \(1000\/month, 20\/request\), user 2 on Premium \(10000\/month, 100\/request\), both read with this account's key$/m,
  ],
  [
    "an accepted request with both levels' usage and remaining",
    /^\[ok\] accepted request: \S+-basic-accepted: ACCEPTED 10 units \| user "Basic" 10 used, 990 remaining \| account "Starter" 10 used, 9990 remaining$/m,
  ],
  [
    "a byte-identical retry that counts nothing",
    /^\[ok\] idempotent retry: identical response \(\d+ bytes\); account usage still 10$/m,
  ],
  [
    "a rejection by the user's limit, counting nothing",
    /^\[ok\] user-limit rejection: \S+-basic-rejected: REJECTED 25 units by USER MAX_UNITS_PER_REQUEST \| user "Basic" 10 used, 990 remaining \| account "Starter" 10 used, 9990 remaining; .*nothing was counted$/m,
  ],
  [
    "the other user plan allowing the same amount",
    /^\[ok\] Premium user allowed the same amount: \S+-premium-accepted: ACCEPTED 25 units \| user "Premium" 25 used, 9975 remaining \| account "Starter" 35 used, 9965 remaining; /m,
  ],
  [
    "a custom account plan at exactly the usage so far",
    /^\[ok\] assign it to the account: account now on "Example shared cap": 35 of 35 used, 0 remaining$/m,
  ],
  [
    "a rejection by the shared account limit that the user plan would allow",
    /^\[ok\] account-limit rejection: \S+-account-rejected: REJECTED 5 units by ACCOUNT MONTHLY_ALLOWANCE \| user "Premium" 25 used, 9975 remaining \| account "Example shared cap" 35 used, 0 remaining; user plan alone would allow it .*nothing was counted$/m,
  ],
  [
    "a plan update",
    /^\[ok\] raise the shared plan: "Example shared cap" monthly allowance 35 -> 40$/m,
  ],
  [
    "the same request accepted after the update, with no client change",
    /^\[ok\] accepted after the plan update: \S+-account-accepted: ACCEPTED 5 units \| user "Premium" 30 used, 9970 remaining \| account "Example shared cap" 40 used, 0 remaining; /m,
  ],
  [
    "exact account and per-user totals",
    /^\[ok\] user usage: 10 \+ 30 \+ 0 = 40 units, the account's total$/m,
  ],
  [
    "the complete history with no extra decision",
    /^\[ok\] walk GET \/v1\/history: 5 decisions in 5 pages, each as originally returned$/m,
  ],
  [
    "the final summary",
    /^Example workflow passed: account [0-9a-f-]{36}, month \d{4}-\d{2}, 3 users, 3 accepted and 2 rejected decisions, 40 units used; walked 3\/3\/5 pages \(users\/usage\/history\)\.$/m,
  ],
];

/** Anything shaped like an API key, including a partial one. */
const KEY_LIKE = /umqs_[A-Za-z0-9_-]{8,}/;

interface ClientRun {
  readonly source: string;
  readonly code: number | null;
  readonly output: string;
}

function runHostClient(): Promise<ClientRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "client/main.ts"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ source: "client/main.ts on the host", code, output });
    });
  });
}

async function clientRun(): Promise<ClientRun> {
  const log = process.env.CLIENT_LOG;
  if (log === undefined || log === "") {
    return runHostClient();
  }
  const code = process.env.CLIENT_EXIT_CODE ?? "";
  return {
    source: "the Compose client service",
    code: /^\d+$/.test(code) ? Number(code) : null,
    output: readFileSync(log, "utf8"),
  };
}

describe("example client against the running service", () => {
  it("demonstrates every required behavior, exits 0 and never prints an API key", async () => {
    const run = await clientRun();

    // Checked before anything is printed, so a leaked key never reaches the CI log.
    const leaked = KEY_LIKE.test(run.output);
    process.stdout.write(`Checked output of ${run.source}:\n${redactApiKeys(run.output)}\n`);

    expect(leaked, "an API-key-shaped value appeared in the client output").toBe(false);
    expect(run.output).not.toContain("Example client failed");
    expect(run.code).toBe(0);
    let previous = -1;
    for (const step of STEPS) {
      const at = run.output.indexOf(`[ok] ${step}: `);
      expect(at, `step "${step}" passed after the previous one`).toBeGreaterThan(previous);
      previous = at;
    }
    for (const [behavior, line] of EVIDENCE) {
      expect(run.output, behavior).toMatch(line);
    }
  });
});
