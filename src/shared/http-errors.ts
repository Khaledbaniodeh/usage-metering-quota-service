import { Type, type Static } from "typebox";
import {
  ERROR_CODES,
  errorDefinition,
  type ErrorCode,
  type ErrorStatus,
} from "./error-catalogue.js";

export type { ErrorCode } from "./error-catalogue.js";

const errorResponseProperties = {
  error: Type.Object(
    {
      code: Type.Enum(ERROR_CODES, { description: "Stable machine-readable error code" }),
      message: Type.String({ description: "Human-readable explanation" }),
    },
    { additionalProperties: false },
  ),
};

/** The single JSON error shape used by every endpoint. */
export const ErrorResponseSchema = Type.Object(errorResponseProperties, {
  additionalProperties: false,
  description: "Standard error response",
});

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

type ErrorResponseSchemas<Codes extends ErrorCode> = {
  readonly [Code in Codes as ErrorStatus<Code>]: typeof ErrorResponseSchema;
};

/**
 * Route response schemas for the error codes a route can return, keyed by their catalogue status,
 * e.g. `response: { 201: Created, ...errorResponseSchemas("VALIDATION_ERROR", "INTERNAL_ERROR") }`.
 * Codes sharing a status share one schema whose description lists them.
 */
export function errorResponseSchemas<const Codes extends readonly ErrorCode[]>(
  ...codes: Codes
): ErrorResponseSchemas<Codes[number]> {
  const codesByStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const { statusCode } = errorDefinition(code);
    codesByStatus.set(statusCode, [...(codesByStatus.get(statusCode) ?? []), code]);
  }
  return Object.fromEntries(
    [...codesByStatus].map(([statusCode, statusCodes]) => [
      statusCode,
      Type.Object(errorResponseProperties, {
        additionalProperties: false,
        description: `Error response (${statusCodes.join(", ")})`,
      }),
    ]),
  ) as ErrorResponseSchemas<Codes[number]>;
}

/** An error whose code, status and message are safe to return to the client. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message?: string, options?: ErrorOptions) {
    const definition = errorDefinition(code);
    super(message ?? definition.message, options);
    this.name = "AppError";
    this.code = code;
    this.statusCode = definition.statusCode;
  }
}

export interface MappedError {
  readonly statusCode: number;
  readonly body: ErrorResponse;
}

export function errorResponse(code: ErrorCode, message?: string): ErrorResponse {
  return { error: { code, message: message ?? errorDefinition(code).message } };
}

const CLIENT_ERROR_CODES: ReadonlyMap<number, ErrorCode> = new Map([
  [400, "BAD_REQUEST"],
  [401, "UNAUTHORIZED"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [413, "PAYLOAD_TOO_LARGE"],
  [415, "UNSUPPORTED_MEDIA_TYPE"],
]);

/**
 * Maps any thrown value to a status code and the standard error body.
 *
 * Only AppError instances and Fastify's own client (4xx) errors expose their message. Everything
 * else becomes a generic 500 so that internal details (SQL, stack traces, connection data,
 * credentials) never reach the client.
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

  return { statusCode: 500, body: errorResponse("INTERNAL_ERROR") };
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const { statusCode } = error;
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}
