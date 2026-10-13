/**
 * The single catalogue of public error codes. Every error response carries one of these codes in
 * `error.code`; the HTTP status of a code is defined here and nowhere else. Codes are part of the
 * public API contract: add new ones deliberately and never change the meaning of an existing one.
 */

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "PLAN_READ_ONLY",
  "PLAN_SCOPE_MISMATCH",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "BUSY_RETRY",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDefinition {
  readonly statusCode: number;
  /** Default client-facing message; never contains request data, SQL or credentials. */
  readonly message: string;
}

/** `satisfies` makes the compiler reject a missing, extra or misspelled code. */
export const ERROR_CATALOGUE = {
  VALIDATION_ERROR: { statusCode: 400, message: "The request is invalid" },
  BAD_REQUEST: { statusCode: 400, message: "The request could not be processed" },
  UNAUTHORIZED: { statusCode: 401, message: "A valid API key is required" },
  NOT_FOUND: { statusCode: 404, message: "The requested resource was not found" },
  CONFLICT: {
    statusCode: 409,
    message: "The request conflicts with the current state of the resource",
  },
  IDEMPOTENCY_CONFLICT: {
    statusCode: 409,
    message: "The request ID was already used with a different payload",
  },
  PLAN_READ_ONLY: { statusCode: 409, message: "Predefined plans are read-only" },
  PLAN_SCOPE_MISMATCH: {
    statusCode: 409,
    message: "The plan scope does not match the assignment target",
  },
  PAYLOAD_TOO_LARGE: { statusCode: 413, message: "The request body is too large" },
  UNSUPPORTED_MEDIA_TYPE: { statusCode: 415, message: "The request content type is not supported" },
  BUSY_RETRY: { statusCode: 503, message: "The service is busy; retry the same request shortly" },
  SERVICE_UNAVAILABLE: { statusCode: 503, message: "The service is not ready" },
  INTERNAL_ERROR: { statusCode: 500, message: "Internal server error" },
} as const satisfies Record<ErrorCode, ErrorDefinition>;

/** The HTTP status of an error code, as a literal type (for typed route response schemas). */
export type ErrorStatus<Code extends ErrorCode> = (typeof ERROR_CATALOGUE)[Code]["statusCode"];

const DEFINITIONS: ReadonlyMap<string, ErrorDefinition> = new Map(Object.entries(ERROR_CATALOGUE));

export function errorDefinition(code: ErrorCode): ErrorDefinition {
  const definition = DEFINITIONS.get(code);
  if (definition === undefined) {
    // Unreachable while ERROR_CATALOGUE satisfies Record<ErrorCode, ErrorDefinition>.
    throw new Error(`Unknown error code: ${code}`);
  }
  return definition;
}
