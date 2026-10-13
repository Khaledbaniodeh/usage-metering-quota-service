import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

/**
 * API keys look like `umqs_<43 base64url characters>`: 32 cryptographically random bytes encoded
 * as unpadded base64url. Only the SHA-256 digest of the entire key (prefix included) is stored.
 *
 * A plain SHA-256 is sufficient because the key carries 256 bits of entropy: unlike a password it
 * cannot be guessed or precomputed, so salts or slow hashes would add cost without adding safety,
 * and a deterministic digest allows a direct indexed lookup.
 */

export const API_KEY_PREFIX = "umqs_";
export const API_KEY_RANDOM_BYTES = 32;

/** 32 bytes in unpadded base64url are exactly 43 characters. */
const API_KEY_PATTERN = /^umqs_[A-Za-z0-9_-]{43}$/;

/** Source of random bytes; injectable so unit tests do not depend on real entropy. */
export type RandomBytesSource = (size: number) => Buffer;

const secureRandomBytes: RandomBytesSource = (size) => cryptoRandomBytes(size);

export function generateApiKey(randomBytes: RandomBytesSource = secureRandomBytes): string {
  const bytes = randomBytes(API_KEY_RANDOM_BYTES);
  if (bytes.length !== API_KEY_RANDOM_BYTES) {
    throw new Error(
      `The random source returned ${String(bytes.length)} bytes instead of ${String(API_KEY_RANDOM_BYTES)}`,
    );
  }
  return `${API_KEY_PREFIX}${bytes.toString("base64url")}`;
}

/** Structural check only: says nothing about whether the key belongs to an account. */
export function isWellFormedApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

/** SHA-256 of the entire key as presented (UTF-8), 32 bytes. */
export function hashApiKey(apiKey: string): Buffer {
  return createHash("sha256").update(apiKey, "utf8").digest();
}
