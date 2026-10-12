import type { FastifyInstance } from "fastify";
import { errorResponse, toErrorResponse } from "../shared/http-errors.js";

/** Installs the single error contract: every failure is answered with the standard error shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toErrorResponse(error);
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    return reply.status(statusCode).send(body);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorResponse("NOT_FOUND", "Route not found")),
  );
}
