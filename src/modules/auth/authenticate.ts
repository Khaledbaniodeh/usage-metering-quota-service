import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../shared/http-errors.js";
import { hashApiKey, isWellFormedApiKey } from "./api-key.js";

/**
 * X-API-Key authentication for protected routes.
 *
 * The header must appear exactly once and is used byte-for-byte (no trimming or normalization).
 * A well-formed key is hashed with SHA-256 and resolved to its account by digest; the account is
 * never taken from client-supplied IDs. Missing, repeated, malformed and unknown keys all receive
 * the same 401 response, so a caller cannot tell which check failed.
 */

export const API_KEY_HEADER = "X-API-Key";

export interface AuthenticatedAccount {
  readonly id: string;
}

/** Looks up the account that owns an API-key digest (implemented by the accounts repository). */
export type ResolveAccountByApiKeyHash = (
  apiKeyHash: Buffer,
) => Promise<AuthenticatedAccount | undefined>;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the authentication hook on protected routes; null on public routes. */
    authenticatedAccount: AuthenticatedAccount | null;
  }
}

/**
 * Returns the raw value of the X-API-Key header when it appears exactly once, otherwise undefined.
 * Reads the raw header list because Node joins repeated custom headers into one comma-separated
 * value, which would hide the repetition.
 */
export function readApiKeyHeader(rawHeaders: readonly string[]): string | undefined {
  const headerName = API_KEY_HEADER.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const value = rawHeaders.at(index + 1);
    if (rawHeaders.at(index)?.toLowerCase() === headerName && value !== undefined) {
      values.push(value);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

/** Declares the per-request authentication slot. Call once while building the application. */
export function registerAuthentication(app: FastifyInstance): void {
  app.decorateRequest("authenticatedAccount", null);
}

/** onRequest hook for protected routes; runs before the body is parsed. */
export function createAuthenticationHook(
  resolveAccount: ResolveAccountByApiKeyHash,
): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const apiKey = readApiKeyHeader(request.raw.rawHeaders);
    if (apiKey === undefined || !isWellFormedApiKey(apiKey)) {
      throw new AppError("UNAUTHORIZED");
    }
    const account = await resolveAccount(hashApiKey(apiKey));
    if (account === undefined) {
      throw new AppError("UNAUTHORIZED");
    }
    request.authenticatedAccount = account;
  };
}

/** The authenticated account of a protected route; a programming error on unprotected routes. */
export function requireAuthenticatedAccount(request: FastifyRequest): AuthenticatedAccount {
  if (request.authenticatedAccount === null) {
    throw new Error("This route is not protected by the authentication hook");
  }
  return request.authenticatedAccount;
}
