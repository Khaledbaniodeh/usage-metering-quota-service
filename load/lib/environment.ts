/**
 * The environment record written before any measurement: what ran, on what, with which limits.
 * Values come from the runner (passed by the workflow), from Node's os module and from the
 * database. Identifiers are validated so a record never silently carries a placeholder.
 */

export interface DatabaseFacts {
  readonly version: string;
  /** Selected pg_settings name → setting (with unit), e.g. shared_buffers → "16384 8kB". */
  readonly settings: Readonly<Record<string, string>>;
}

export interface EnvironmentInput {
  readonly commitSha: string;
  readonly profile: string;
  readonly shape: string;
  readonly node: string;
  readonly platform: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
  /** Human-readable image references and their digests, e.g. "grafana/k6:2.3.0". */
  readonly images: Readonly<
    Record<string, { readonly reference: string; readonly digest: string }>
  >;
  /** Tool versions as reported by the tools themselves. */
  readonly tools: Readonly<Record<string, string>>;
  /** Container CPU and memory limits as read back from docker inspect. */
  readonly limits: Readonly<
    Record<string, { readonly nanoCpus: number; readonly memoryBytes: number }>
  >;
  readonly database: DatabaseFacts;
}

export interface EnvironmentRecord extends EnvironmentInput {
  readonly schema: "umqs-bench-environment/1";
  readonly recordedAt: string;
}

/** Settings recorded with every run: they decide plans, caching and WAL volume. */
export const RECORDED_SETTINGS = [
  "server_version",
  "shared_buffers",
  "effective_cache_size",
  "work_mem",
  "maintenance_work_mem",
  "random_page_cost",
  "max_wal_size",
  "checkpoint_timeout",
  "synchronous_commit",
  "max_connections",
  "shared_preload_libraries",
  "jit",
] as const;

export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function buildEnvironmentRecord(input: EnvironmentInput, now: Date): EnvironmentRecord {
  if (!COMMIT_SHA.test(input.commitSha)) {
    throw new EnvironmentError("commitSha must be a full 40-character lower-case SHA");
  }
  for (const [name, image] of Object.entries(input.images)) {
    if (!DIGEST.test(image.digest)) {
      throw new EnvironmentError(`image ${name} must have a sha256 digest`);
    }
    if (image.reference.trim() === "") {
      throw new EnvironmentError(`image ${name} needs a human-readable reference`);
    }
  }
  if (!Number.isSafeInteger(input.cpuCount) || input.cpuCount < 1) {
    throw new EnvironmentError("cpuCount must be a positive integer");
  }
  for (const [name, limit] of Object.entries(input.limits)) {
    if (!(limit.nanoCpus > 0) || !(limit.memoryBytes > 0)) {
      throw new EnvironmentError(`container ${name} must have CPU and memory limits`);
    }
  }
  const missing = RECORDED_SETTINGS.filter((name) => !(name in input.database.settings));
  if (missing.length > 0) {
    throw new EnvironmentError(`missing PostgreSQL settings: ${missing.join(", ")}`);
  }
  return { schema: "umqs-bench-environment/1", recordedAt: now.toISOString(), ...input };
}
