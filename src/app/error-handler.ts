import type { FastifyInstance } from "fastify";
import { errorResponse, toErrorResponse } from "../shared/http-errors.js";

/** Installs the single error contract: every failure is answered with the standard error shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body, retryAfterSeconds } = toErrorResponse(error);
    if (retryAfterSeconds !== undefined) {
      // An expected, retryable condition (for example BUSY_RETRY): not an application failure.
      request.log.warn({ code: body.error.code }, "request asked to retry");
      return reply.status(statusCode).header("retry-after", String(retryAfterSeconds)).send(body);
    }
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    return reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorResponse("NOT_FOUND", "Route not found")),
  );
}
