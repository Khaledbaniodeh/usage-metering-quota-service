import { AppError } from "../../shared/http-errors.js";

/**
 * Outcome of assigning a plan to an account or a user. The assignment statement checks, in this
 * order: the target exists in the authenticated account, the plan is visible to that account
 * (predefined or its own custom plan) and the plan's scope matches the target.
 */
export type PlanAssignment<Target> =
  | { readonly kind: "assigned"; readonly target: Target }
  | { readonly kind: "target-not-found" }
  | { readonly kind: "plan-not-found" }
  | { readonly kind: "scope-mismatch" };

/** Diagnostic columns that every plan-assignment statement selects next to the target's columns. */
export interface PlanAssignmentDiagnostics {
  readonly target_found: boolean;
  readonly plan_visible: boolean;
}

/** A target row read through a LEFT JOIN: every column is NULL when nothing was assigned. */
export type AssignmentResultRow<Row extends { readonly id: string }> = {
  readonly [Column in keyof Row]: Row[Column] | null;
} & PlanAssignmentDiagnostics;

export function toPlanAssignment<Row extends { readonly id: string }, Target>(
  row: AssignmentResultRow<Row> | undefined,
  toTarget: (row: Row) => Target,
): PlanAssignment<Target> {
  if (row === undefined) {
    throw new Error("The plan assignment statement returned no row");
  }
  if (row.id !== null) {
    // A non-null id means the UPDATE returned the target, so every target column is present.
    return { kind: "assigned", target: toTarget(row as Row) };
  }
  if (!row.target_found) {
    return { kind: "target-not-found" };
  }
  return row.plan_visible ? { kind: "scope-mismatch" } : { kind: "plan-not-found" };
}

/** Unknown plans and other accounts' plans get this same error, so neither can be detected. */
export function planNotFound(): AppError {
  return new AppError("NOT_FOUND", "Plan not found");
}

/** The assigned target, or the error for a failed assignment. */
export function assignedOrThrow<Target>(
  assignment: PlanAssignment<Target>,
  targetNotFound: () => AppError,
): Target {
  switch (assignment.kind) {
    case "assigned":
      return assignment.target;
    case "target-not-found":
      throw targetNotFound();
    case "plan-not-found":
      throw planNotFound();
    case "scope-mismatch":
      throw new AppError("PLAN_SCOPE_MISMATCH");
  }
}
