/**
 * Deterministic benchmark datasets. Every value is fixed here or derived from these numbers, so a
 * profile always produces the same rows (only the API key, which is a secret, differs per run).
 *
 * The seed is dataset construction by direct SQL. It says nothing about HTTP write performance,
 * which only the k6 consume workloads measure.
 */

/** S2 is the binding shape; S3 is a sensitivity experiment that never decides anything. */
export const DATASET_SHAPES = ["s2", "s3"] as const;
export type DatasetShape = (typeof DATASET_SHAPES)[number];

export const PROFILE_NAMES = ["smoke", "full"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** Twelve fixed UTC months, stored as their first day. The oldest is the one measured. */
export const SEED_MONTHS: readonly string[] = Array.from(
  { length: 12 },
  (_unused, index) => `2025-${String(index + 1).padStart(2, "0")}-01`,
);
export const OLDEST_MONTH_KEY = "2025-01";

/** The history page size measured before and after every candidate change. */
export const HISTORY_PAGE_LIMIT = 20;

export interface DatasetProfile {
  readonly name: ProfileName;
  /** Decisions of the heavy user, spread evenly over SEED_MONTHS. */
  readonly heavyUserDecisions: number;
  /** Other users of the heavy account. */
  readonly backgroundUsers: number;
  readonly backgroundDecisionsPerUser: number;
  /** Users and decisions of the separate noise tenant, spread evenly over SEED_MONTHS. */
  readonly noiseUsers: number;
  readonly noiseDecisions: number;
  /** Every n-th decision exceeds the user's per-request limit and is rejected. */
  readonly rejectEvery: number;
}

export const PROFILES: Readonly<Record<ProfileName, DatasetProfile>> = {
  full: {
    name: "full",
    heavyUserDecisions: 1_200_000,
    backgroundUsers: 99,
    backgroundDecisionsPerUser: 2_000,
    noiseUsers: 10,
    noiseDecisions: 100_000,
    rejectEvery: 50,
  },
  // The same shape scaled down 100 times (users unchanged), for validating the pipeline.
  smoke: {
    name: "smoke",
    heavyUserDecisions: 12_000,
    backgroundUsers: 99,
    backgroundDecisionsPerUser: 20,
    noiseUsers: 10,
    noiseDecisions: 1_000,
    rejectEvery: 50,
  },
};

/** Plan limits of the seeded tenants: allowances never interfere with the measured behavior. */
export const SEED_PLAN_LIMITS = {
  account: { monthlyAllowance: 1_000_000_000, maxUnitsPerRequest: 1_000 },
  user: { monthlyAllowance: 1_000_000_000, maxUnitsPerRequest: 100 },
} as const;

/** Units of a rejected seed decision: one above the user's per-request limit. */
export const REJECTED_UNITS = SEED_PLAN_LIMITS.user.maxUnitsPerRequest + 1;

export function totalDecisions(profile: DatasetProfile): number {
  return (
    profile.heavyUserDecisions +
    profile.backgroundUsers * profile.backgroundDecisionsPerUser +
    profile.noiseDecisions
  );
}

export class ParameterError extends Error {
  override readonly name = "ParameterError";
}

function oneOf<T extends string>(allowed: readonly T[], raw: string | undefined, what: string): T {
  const value = raw?.trim();
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ParameterError(`${what} must be one of ${allowed.join(", ")}`);
  }
  return match;
}

export function parseProfileName(raw: string | undefined): ProfileName {
  return oneOf(PROFILE_NAMES, raw, "PROFILE");
}

export function parseShape(raw: string | undefined): DatasetShape {
  return oneOf(DATASET_SHAPES, raw, "SHAPE");
}

const MAX_SAFE_DECISIONS = 5_000_000;

/** Rejects any profile the seed SQL cannot represent safely; returns it unchanged otherwise. */
export function validateProfile(profile: DatasetProfile): DatasetProfile {
  const counts: [string, number, number][] = [
    ["heavyUserDecisions", profile.heavyUserDecisions, SEED_MONTHS.length],
    ["backgroundUsers", profile.backgroundUsers, 1],
    ["backgroundDecisionsPerUser", profile.backgroundDecisionsPerUser, 1],
    ["noiseUsers", profile.noiseUsers, 1],
    ["noiseDecisions", profile.noiseDecisions, SEED_MONTHS.length],
    ["rejectEvery", profile.rejectEvery, 2],
  ];
  for (const [what, value, minimum] of counts) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new ParameterError(`${what} must be an integer of at least ${String(minimum)}`);
    }
  }
  if (totalDecisions(profile) > MAX_SAFE_DECISIONS) {
    throw new ParameterError(`a profile may seed at most ${String(MAX_SAFE_DECISIONS)} decisions`);
  }
  return profile;
}
