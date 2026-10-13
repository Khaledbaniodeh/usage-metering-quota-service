import { Type, type Static } from "typebox";

/**
 * Stable, machine-readable error codes returned in the `error.code` field of every error response.
 * Later phases extend this catalogue (for example with authentication and idempotency errors).
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

/** The single JSON error shape used by every endpoint. */
export const ErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ description: "Stable machine-readable error code" }),
        message: Type.String({ description: "Human-readable explanation" }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, description: "Standard error response" },
);

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

/** An error whose status, code and message are safe to return to the client. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface MappedError {
  readonly statusCode: number;
  readonly body: ErrorResponse;
}

export function errorResponse(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}

const CLIENT_ERROR_CODES: ReadonlyMap<number, ErrorCode> = new Map([
  [400, "BAD_REQUEST"],
  [404, "NOT_FOUND"],
  [413, "PAYLOAD_TOO_LARGE"],
  [415, "UNSUPPORTED_MEDIA_TYPE"],
]);

/**
 * Maps any thrown value to a status code and the standard error body.
 *
 * Only AppError instances and Fastify's own client (4xx) errors expose their message. Everything
 * else becomes a generic 500 so that internal details (SQL, stack traces, connection data) never
 * reach the client.
 */
export function toErrorResponse(error: unknown): MappedError {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, body: errorResponse(error.code, error.message) };
  }

  if (error instanceof Error && "validation" in error) {
    return { statusCode: 400, body: errorResponse("VALIDATION_ERROR", error.message) };
  }

  const statusCode = readStatusCode(error);
  if (error instanceof Error && statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    const code = CLIENT_ERROR_CODES.get(statusCode) ?? "BAD_REQUEST";
    return { statusCode, body: errorResponse(code, error.message) };
  }

  return { statusCode: 500, body: errorResponse("INTERNAL_ERROR", "Internal server error") };
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const { statusCode } = error;
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}
