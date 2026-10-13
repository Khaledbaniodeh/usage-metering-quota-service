import { describe, expect, it } from "vitest";
import { AppError, toErrorResponse } from "../../../src/shared/http-errors.js";

function clientError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

describe("toErrorResponse", () => {
  it("exposes the status, code and message of an AppError", () => {
    expect(toErrorResponse(new AppError("SERVICE_UNAVAILABLE", "Not ready"))).toEqual({
      statusCode: 503,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "Not ready" } },
    });
  });

  it("tells the client when to retry a BUSY_RETRY error", () => {
    expect(toErrorResponse(new AppError("BUSY_RETRY"))).toEqual({
      statusCode: 503,
      body: {
        error: {
          code: "BUSY_RETRY",
          message: "The service is busy; retry the same request shortly",
        },
      },
      retryAfterSeconds: 1,
    });
  });

  it("maps schema validation failures to 400 VALIDATION_ERROR", () => {
    const error = Object.assign(new Error("body/units must be integer"), {
      statusCode: 400,
      validation: [],
    });

    expect(toErrorResponse(error)).toEqual({
      statusCode: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "body/units must be integer" } },
    });
  });

  it.each([
    [400, "BAD_REQUEST"],
    [404, "NOT_FOUND"],
    [413, "PAYLOAD_TOO_LARGE"],
    [415, "UNSUPPORTED_MEDIA_TYPE"],
    [405, "BAD_REQUEST"],
  ])("maps a %i client error to %s and keeps its message", (statusCode, code) => {
    expect(toErrorResponse(clientError(statusCode, "client problem"))).toEqual({
      statusCode,
      body: { error: { code, message: "client problem" } },
    });
  });

  it.each([
    ["a generic error", new Error("connect ECONNREFUSED 10.0.0.5:5432")],
    ["a server-side status", clientError(502, "upstream exploded")],
    ["a non-error value", "boom"],
    ["an object with a non-integer status", { statusCode: "400" }],
    ["null", null],
  ])("hides internal details of %s behind a 500", (_label, error) => {
    expect(toErrorResponse(error)).toEqual({
      statusCode: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    });
  });
});
