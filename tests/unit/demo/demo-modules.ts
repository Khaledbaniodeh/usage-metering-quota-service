import { randomBytes } from "node:crypto";

/**
 * The interview demo (demo/) is plain JavaScript that runs unbuilt in Node and in the browser, so
 * its modules have no type declarations. The tests load them at run time and describe here only
 * the part of their contract the tests rely on.
 */

const DEMO_DIRECTORY = new URL("../../../demo/", import.meta.url);

/** Absolute URL of a file under demo/. */
export function demoFile(relativePath: string): URL {
  return new URL(relativePath, DEMO_DIRECTORY);
}

/**
 * A random, well-formed API key built at run time, so no key-shaped value is stored in the
 * repository. It belongs to no account.
 */
export function randomApiKey(): string {
  return `umqs_${randomBytes(32).toString("base64url")}`;
}

export interface DemoConfig {
  readonly host: string;
  readonly port: number;
  readonly apiBaseUrl: string;
}

export interface RunningDemoServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface DemoServerOptions {
  readonly log?: (line: string) => void;
  readonly upstreamTimeoutMs?: number;
}

export interface DemoServerModule {
  readonly DEFAULT_HOST: string;
  readonly DEFAULT_PORT: number;
  readonly DEFAULT_API_BASE_URL: string;
  readonly MAX_BODY_BYTES: number;
  readonly DemoConfigError: new (issues: readonly string[]) => Error & {
    readonly issues: readonly string[];
  };
  loadDemoConfig(env: Readonly<Record<string, string | undefined>>): DemoConfig;
  startDemoServer(config: DemoConfig, options?: DemoServerOptions): Promise<RunningDemoServer>;
  parseTarget(rawTarget: string): { readonly path: string; readonly search: string } | undefined;
  sanitizeLogLine(line: string): string;
}

export type Query = Readonly<Record<string, string | undefined>>;

export interface PaginationState {
  readonly filters: Query;
  readonly limit: number;
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
  readonly pages: number;
}

export interface LevelSummary {
  readonly label: string;
  readonly scope: "USER" | "ACCOUNT";
  readonly blocking: boolean;
  readonly planName: unknown;
  readonly used: unknown;
  readonly remaining: unknown;
  readonly monthlyAllowance: unknown;
  readonly maxUnitsPerRequest: unknown;
  readonly percentUsed: number;
}

export interface DecisionSummary {
  readonly accepted: boolean;
  readonly outcome: string;
  readonly requestId: unknown;
  readonly userId: unknown;
  readonly units: unknown;
  readonly month: unknown;
  readonly processedAt: unknown;
  readonly blockingRule: unknown;
  readonly blockingLevel: unknown;
  readonly blockedBy: string | null;
  readonly explanation: string;
  readonly levels: readonly LevelSummary[];
}

export interface UsageSummary {
  readonly month: unknown;
  readonly used: unknown;
  readonly currentMonth: boolean;
  readonly monthlyAllowance: unknown;
  readonly maxUnitsPerRequest: unknown;
  readonly remaining: unknown;
  readonly percentUsed: number | null;
}

export interface Failure {
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
}

export interface FailureInput {
  readonly status: number;
  readonly data: unknown;
  readonly networkError?: boolean;
  readonly retryAfter?: string | null;
}

export interface RequestDescription {
  readonly method: string;
  readonly path: string;
  readonly query?: Query;
  readonly status?: number;
  readonly durationMs?: number;
  readonly networkError?: boolean;
}

export interface HelpersModule {
  readonly REQUEST_ID_RULE: string;
  readonly MASKED_API_KEY: string;
  newRequestId(randomUUID: () => string): string;
  requestIdAdvice(value: string): string | null;
  toJsonNumber(text: string): number | string | undefined;
  toQueryString(params: Query): string;
  describeRequest(request: RequestDescription): string;
  startPagination(filters: Query, limit: number): PaginationState;
  firstPageQuery(state: PaginationState): Query;
  nextPageQuery(state: PaginationState): { readonly cursor: string; readonly limit: string } | null;
  hasNextPage(state: PaginationState | null | undefined): boolean;
  addPage(state: PaginationState, items: readonly unknown[], nextCursor: unknown): PaginationState;
  summarizeDecision(decision: unknown): DecisionSummary;
  summarizeUsage(usage: unknown): UsageSummary;
  redactText(text: string): string;
  redactSecrets(value: unknown): unknown;
  withoutApiKey(value: object): Record<string, unknown>;
  describeFailure(result: FailureInput): Failure;
  formatNumber(value: unknown): string;
  formatTimestamp(value: unknown): string;
  shortId(value: unknown): string;
  defaultAccountName(date: Date): string;
  planKind(plan: { readonly code: string | null }): string;
}

export interface ApiResult {
  readonly method: string;
  readonly path: string;
  readonly query: Query;
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
  readonly data: unknown;
  readonly retryAfter: string | null;
  readonly durationMs: number;
  readonly networkError: boolean;
}

export interface ApiRequest {
  readonly method?: string;
  readonly path: string;
  readonly query?: Query;
  readonly body?: unknown;
  readonly apiKey?: string | null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiModule {
  readonly createApiCaller: (dependencies: {
    readonly fetch: FetchLike;
    readonly now: () => number;
  }) => (request: ApiRequest) => Promise<ApiResult>;
}

export async function loadServerModule(): Promise<DemoServerModule> {
  return (await import(demoFile("server.js").href)) as DemoServerModule;
}

export async function loadHelpersModule(): Promise<HelpersModule> {
  return (await import(demoFile("public/helpers.js").href)) as HelpersModule;
}

export async function loadApiModule(): Promise<ApiModule> {
  return (await import(demoFile("public/api.js").href)) as ApiModule;
}
