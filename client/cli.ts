import { randomBytes } from "node:crypto";
import { ApiError, createApiClient, DEFAULT_BASE_URL, type FetchFunction } from "./api-client.js";
import { redactApiKeys } from "./api-key.js";
import { runExampleWorkflow, WorkflowFailure, type WorkflowSummary } from "./workflow.js";

export const EXIT_OK = 0;
export const EXIT_WORKFLOW_FAILED = 1;
export const EXIT_CONFIGURATION = 2;

export interface CliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Injected by tests; the real fetch otherwise. */
  readonly fetch?: FetchFunction;
  readonly runId?: string;
}

/** A unique, request-ID-safe tag for this run: base-36 time plus random hex. */
export function newRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function summaryLine(summary: WorkflowSummary): string {
  const { pages } = summary;
  return (
    `Example workflow passed: account ${summary.accountId}, month ${summary.month}, ` +
    `${String(summary.users)} users, ${String(summary.acceptedDecisions)} accepted and ` +
    `${String(summary.rejectedDecisions)} rejected decisions, ${String(summary.unitsUsed)} units used; ` +
    `walked ${String(pages.users)}/${String(pages.usage)}/${String(pages.history)} pages ` +
    "(users/usage/history)."
  );
}

/**
 * Runs the example workflow against API_BASE_URL and returns the process exit code. Every line
 * written passes through redactApiKeys, although the workflow never puts a key into one.
 */
export async function runCli(context: CliContext): Promise<number> {
  const out = (line: string) => {
    context.stdout(redactApiKeys(line));
  };
  const err = (line: string) => {
    context.stderr(redactApiKeys(line));
  };

  const configured = context.env.API_BASE_URL?.trim() ?? "";
  const baseUrl = configured === "" ? DEFAULT_BASE_URL : configured;
  let api;
  try {
    api =
      context.fetch === undefined
        ? createApiClient({ baseUrl })
        : createApiClient({ baseUrl, fetch: context.fetch });
  } catch (error) {
    err(`Example client: ${error instanceof Error ? error.message : "invalid configuration"}`);
    return EXIT_CONFIGURATION;
  }

  out(`Example client: running the workflow against ${new URL(baseUrl).origin}`);
  try {
    const summary = await runExampleWorkflow(api, { runId: context.runId ?? newRunId(), log: out });
    out(summaryLine(summary));
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof WorkflowFailure)) {
      err(
        `Example client failed: ${error instanceof Error ? error.message : "unexpected failure"}`,
      );
      return EXIT_WORKFLOW_FAILED;
    }
    err(`Example client failed at step "${error.step}": ${error.message}`);
    if (error.reason instanceof ApiError && error.reason.kind === "network") {
      err("Is the service running? Start it with `docker compose up --wait`, or set API_BASE_URL.");
    }
    return EXIT_WORKFLOW_FAILED;
  }
}
