/**
 * Redaction and secret scanning for everything the benchmark prints or keeps. Scanning reports
 * only what kind of secret was found and where (line number), never the value.
 */

/** API keys of this service (`umqs_` + key characters), including partial ones. */
const API_KEY = /umqs_[A-Za-z0-9_-]{8,}/g;
const API_KEY_IN_LINE = /umqs_[A-Za-z0-9_-]{8,}/;
/** Credentials embedded in a PostgreSQL URL: postgres[ql]://user:password@ */
const DATABASE_URL_PASSWORD = /(postgres(?:ql)?:\/\/[^\s:/@]+):([^\s@/]+)@/gi;
/** Literal secrets shorter than this are not scanned for: they would match ordinary text. */
export const MIN_LITERAL_LENGTH = 6;

export const REDACTED = "[REDACTED]";

function usableLiterals(literals: readonly string[]): string[] {
  return literals.filter((literal) => literal.length >= MIN_LITERAL_LENGTH);
}

/** Replaces API keys, database URL passwords and the given literal secrets. */
export function redactSecrets(text: string, literals: readonly string[] = []): string {
  let redacted = text
    .replace(API_KEY, `umqs_${REDACTED}`)
    .replace(DATABASE_URL_PASSWORD, `$1:${REDACTED}@`);
  for (const literal of usableLiterals(literals)) {
    redacted = redacted.split(literal).join(REDACTED);
  }
  return redacted;
}

export type SecretKind = "api-key" | "database-url-password" | "literal";

export interface SecretFinding {
  readonly kind: SecretKind;
  /** 1-based line number. */
  readonly line: number;
}

/** Every secret in `text`, by kind and line; the values themselves are never returned. */
export function findSecrets(text: string, literals: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const secrets = usableLiterals(literals);
  text.split("\n").forEach((content, index) => {
    const line = index + 1;
    if (API_KEY_IN_LINE.test(content)) {
      findings.push({ kind: "api-key", line });
    }
    // matchAll works on a copy of the global expression, so its lastIndex is never shared.
    for (const match of content.matchAll(DATABASE_URL_PASSWORD)) {
      if (match[2] !== REDACTED) {
        findings.push({ kind: "database-url-password", line });
      }
    }
    if (secrets.some((secret) => content.includes(secret))) {
      findings.push({ kind: "literal", line });
    }
  });
  return findings;
}
