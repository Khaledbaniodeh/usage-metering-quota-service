import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ApiKey, redactApiKeys } from "../../../client/api-key.js";
import { sampleApiKey } from "../../helpers/fake-fetch.js";

describe("ApiKey", () => {
  const raw = sampleApiKey();
  const key = new ApiKey(raw);

  it("reveals the key only on request", () => {
    expect(key.reveal()).toBe(raw);
  });

  it("never shows the key when converted, serialized or inspected", () => {
    const renderings = [
      String(key),
      JSON.stringify(key),
      JSON.stringify({ nested: { key } }),
      inspect(key),
      inspect({ nested: { key } }, { depth: 5 }),
      format("%s %o %O %j", key, key, key, { key }),
    ];
    for (const rendering of renderings) {
      expect(rendering).not.toContain(raw);
      expect(rendering).toContain("[REDACTED]");
    }
  });

  it("exposes no enumerable property holding the key", () => {
    expect(Object.keys(key)).toEqual([]);
    expect(Object.values(key)).not.toContain(raw);
  });
});

describe("redactApiKeys", () => {
  it("replaces every key-shaped token", () => {
    const first = sampleApiKey();
    const second = sampleApiKey();

    const redacted = redactApiKeys(`a ${first} b "${second}"`);

    expect(redacted).toBe('a umqs_[REDACTED] b "umqs_[REDACTED]"');
  });

  it("leaves text without keys unchanged, including the documented key placeholder", () => {
    const text = "Keys look like umqs_<43 characters>; prefix umqs_ alone is fine.";

    expect(redactApiKeys(text)).toBe(text);
  });
});
