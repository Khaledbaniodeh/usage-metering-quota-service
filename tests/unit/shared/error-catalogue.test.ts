import { describe, expect, it } from "vitest";
import { ERROR_CODES, errorDefinition } from "../../../src/shared/error-catalogue.js";
import {
  AppError,
  ErrorResponseSchema,
  errorResponse,
  errorResponseSchemas,
  toErrorResponse,
} from "../../../src/shared/http-errors.js";

describe("error catalogue", () => {
  it("defines each code once, with an error status and a non-empty message", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      const { statusCode, message } = errorDefinition(code);
      expect(statusCode).toBeGreaterThanOrEqual(400);
      expect(statusCode).toBeLessThan(600);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["VALIDATION_ERROR", 400],
    ["UNAUTHORIZED", 401],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["BUSY_RETRY", 503],
    ["SERVICE_UNAVAILABLE", 503],
    ["INTERNAL_ERROR", 500],
  ] as const)("maps %s to HTTP %i", (code, statusCode) => {
    expect(errorDefinition(code).statusCode).toBe(statusCode);
  });

  it("advertises exactly the catalogue codes in the response schema", () => {
    const schema = ErrorResponseSchema as unknown as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };
    const advertised = schema.properties.error.properties.code.enum;

    expect(advertised).toEqual([...ERROR_CODES]);
  });
});

describe("AppError", () => {
  it("takes its status from the catalogue and its message from the catalogue by default", () => {
    const error = new AppError("UNAUTHORIZED");

    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).toBe("A valid API key is required");
    expect(toErrorResponse(error)).toEqual({
      statusCode: 401,
      body: { error: { code: "UNAUTHORIZED", message: "A valid API key is required" } },
    });
  });

  it("accepts a specific safe message and a cause that is never exposed", () => {
    const error = new AppError("CONFLICT", "Already exists", {
      cause: new Error("duplicate key value violates unique constraint"),
    });

    expect(toErrorResponse(error).body).toEqual({
      error: { code: "CONFLICT", message: "Already exists" },
    });
    expect(JSON.stringify(toErrorResponse(error))).not.toContain("duplicate key");
  });
});

describe("errorResponse", () => {
  it("uses the catalogue message unless a message is given", () => {
    expect(errorResponse("BUSY_RETRY")).toEqual({
      error: { code: "BUSY_RETRY", message: "The service is busy; retry the same request shortly" },
    });
    expect(errorResponse("NOT_FOUND", "Route not found")).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });
});

describe("errorResponseSchemas", () => {
  it("groups codes by HTTP status for OpenAPI", () => {
    const schemas = errorResponseSchemas("VALIDATION_ERROR", "CONFLICT", "IDEMPOTENCY_CONFLICT");

    expect(Object.keys(schemas).sort()).toEqual(["400", "409"]);
    expect((schemas[409] as unknown as { description: string }).description).toBe(
      "Error response (CONFLICT, IDEMPOTENCY_CONFLICT)",
    );
  });
});

describe("toErrorResponse for framework client errors", () => {
  it.each([
    [401, "UNAUTHORIZED"],
    [409, "CONFLICT"],
  ] as const)("maps a %i client error to %s", (statusCode, code) => {
    const error = Object.assign(new Error("framework message"), { statusCode });

    expect(toErrorResponse(error)).toEqual({
      statusCode,
      body: { error: { code, message: "framework message" } },
    });
  });
});
