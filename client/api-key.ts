import { inspect } from "node:util";

/**
 * Holds an API key in memory without letting it reach output by accident. Converting it to a
 * string, serializing it to JSON or inspecting it (console.log, util.inspect, error causes) all
 * produce "[REDACTED]"; only `reveal()`, used when building the X-API-Key header, returns the key.
 */
export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `ApiKey(${REDACTED})`;
  }
}

const REDACTED = "[REDACTED]";

/** Anything shaped like a service API key: the `umqs_` prefix followed by key characters. */
const API_KEY_LIKE = /umqs_[A-Za-z0-9_-]{8,}/g;

/**
 * Last line of defense for diagnostic text: replaces every API-key-shaped token. The client never
 * puts a key into a message, so this should never change anything; it guards against mistakes.
 */
export function redactApiKeys(text: string): string {
  return text.replace(API_KEY_LIKE, "umqs_[REDACTED]");
}
