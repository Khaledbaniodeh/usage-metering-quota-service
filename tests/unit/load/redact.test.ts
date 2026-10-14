import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findSecrets, redactSecrets } from "../../../load/lib/redact.js";

const apiKey = () => `umqs_${randomBytes(32).toString("base64url")}`;

describe("redactSecrets", () => {
  it("replaces API keys, including partial ones", () => {
    const key = apiKey();

    expect(redactSecrets(`key=${key} partial=${key.slice(0, 15)}`)).toBe(
      "key=umqs_[REDACTED] partial=umqs_[REDACTED]",
    );
  });

  it("replaces passwords in PostgreSQL URLs and keeps the rest of the URL", () => {
    expect(
      redactSecrets("postgres://usage_metering:s3cr3t-pw@127.0.0.1:15432/usage_metering_bench"),
    ).toBe("postgres://usage_metering:[REDACTED]@127.0.0.1:15432/usage_metering_bench");
    expect(redactSecrets("postgresql://u:p@h/db")).toBe("postgresql://u:[REDACTED]@h/db");
  });

  it("replaces literal secrets of at least 6 characters, and ignores shorter ones", () => {
    expect(redactSecrets("password ci-bench-only here", ["ci-bench-only"])).toBe(
      "password [REDACTED] here",
    );
    expect(redactSecrets("a b c", ["a"])).toBe("a b c");
  });

  it("leaves ordinary text and the documented key placeholder unchanged", () => {
    const text = "Keys look like umqs_<43 characters>; GET /v1/history?limit=20";

    expect(redactSecrets(text)).toBe(text);
  });
});

describe("findSecrets", () => {
  it("reports kind and line, never the value", () => {
    const key = apiKey();
    const text = ["ok", `X-API-Key: ${key}`, "postgres://u:hunter22@db/x", "pw ci-bench-only"].join(
      "\n",
    );

    const findings = findSecrets(text, ["ci-bench-only"]);

    expect(findings).toEqual([
      { kind: "api-key", line: 2 },
      { kind: "database-url-password", line: 3 },
      { kind: "literal", line: 4 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(key);
    expect(JSON.stringify(findings)).not.toContain("hunter22");
  });

  it("finds nothing in redacted output", () => {
    const redacted = redactSecrets(`postgres://u:pw1234@h/db ${apiKey()}`, ["pw1234"]);

    expect(findSecrets(redacted, ["pw1234"])).toEqual([]);
  });

  it("finds every occurrence across repeated calls (no shared regex state)", () => {
    const text = `${apiKey()}\npostgres://a:bbbbbb@h/d\npostgres://a:cccccc@h/d`;

    expect(findSecrets(text)).toHaveLength(3);
    expect(findSecrets(text)).toHaveLength(3);
  });
});
