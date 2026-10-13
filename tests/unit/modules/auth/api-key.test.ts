import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
} from "../../../../src/modules/auth/api-key.js";

// Synthetic keys built from fixed bytes; no key issued by the service appears in tests.
const ZERO_KEY = `umqs_${"A".repeat(43)}`;
const ZERO_KEY_SHA256 = "c17df981dac07ca1e0c10ee190f8b72333e31769c71ecfa7145582f89aeb7eb2";

const fixedBytes =
  (byte: number) =>
  (size: number): Buffer =>
    Buffer.alloc(size, byte);

describe("generateApiKey", () => {
  it("encodes 32 random bytes as umqs_ plus 43 unpadded base64url characters", () => {
    expect(generateApiKey(fixedBytes(0x00))).toBe(ZERO_KEY);
    expect(generateApiKey(fixedBytes(0xff))).toBe(`umqs_${"_".repeat(42)}8`);
    expect(ZERO_KEY).toHaveLength(API_KEY_PREFIX.length + 43);
  });

  it("asks the random source for exactly 32 bytes", () => {
    const requested: number[] = [];

    generateApiKey((size) => {
      requested.push(size);
      return Buffer.alloc(size);
    });

    expect(requested).toEqual([32]);
  });

  it("refuses a random source that returns the wrong number of bytes", () => {
    expect(() => generateApiKey(() => Buffer.alloc(31))).toThrow(
      "The random source returned 31 bytes instead of 32",
    );
  });

  it("uses cryptographic randomness by default", () => {
    const first = generateApiKey();
    const second = generateApiKey();

    expect(isWellFormedApiKey(first)).toBe(true);
    expect(isWellFormedApiKey(second)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("hashApiKey", () => {
  it("returns the 32-byte SHA-256 digest of the whole key, prefix included", () => {
    const digest = hashApiKey(ZERO_KEY);

    expect(digest).toHaveLength(32);
    expect(digest.toString("hex")).toBe(ZERO_KEY_SHA256);
    expect(hashApiKey(ZERO_KEY.slice(API_KEY_PREFIX.length)).toString("hex")).not.toBe(
      ZERO_KEY_SHA256,
    );
  });
});

describe("isWellFormedApiKey", () => {
  it.each([
    ["a generated key", ZERO_KEY],
    ["all base64url symbols", `umqs_${"-_aZ09".repeat(7)}x`],
  ])("accepts %s", (_label, value) => {
    expect(isWellFormedApiKey(value)).toBe(true);
  });

  it.each([
    ["an empty value", ""],
    ["the prefix alone", "umqs_"],
    ["a missing prefix", "A".repeat(43)],
    ["an upper-case prefix", `UMQS_${"A".repeat(43)}`],
    ["another prefix", `sk_live_${"A".repeat(43)}`],
    ["42 token characters", `umqs_${"A".repeat(42)}`],
    ["44 token characters", `umqs_${"A".repeat(44)}`],
    ["base64 padding", `umqs_${"A".repeat(42)}=`],
    ["standard base64 symbols", `umqs_${"A".repeat(41)}+/`],
    ["a leading space (no trimming)", ` ${ZERO_KEY}`],
    ["a trailing space (no trimming)", `${ZERO_KEY} `],
    ["a trailing newline", `${ZERO_KEY}\n`],
    ["two keys joined by a comma", `${ZERO_KEY}, ${ZERO_KEY}`],
  ])("rejects %s", (_label, value) => {
    expect(isWellFormedApiKey(value)).toBe(false);
  });
});
