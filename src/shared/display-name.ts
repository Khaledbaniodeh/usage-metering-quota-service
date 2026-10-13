import { Type } from "typebox";

/**
 * One line of printable text: control characters (C0, DEL and C1, i.e. \p{Cc}, which includes NUL
 * that PostgreSQL text cannot store) and the Unicode line/paragraph separators are rejected
 * anywhere, and the first and last characters must not be whitespace.
 */
export const DISPLAY_NAME_PATTERN = "^[^\\s\\p{Cc}](?:[^\\p{Cc}\\u2028\\u2029]*[^\\s\\p{Cc}])?$";

/**
 * Schema for every display name (accounts, plans, users): 1-100 characters with the rules of
 * DISPLAY_NAME_PATTERN. Together they are stricter than the *_name_format database constraints.
 */
export function displayNameSchema(description: string) {
  return Type.String({ minLength: 1, maxLength: 100, pattern: DISPLAY_NAME_PATTERN, description });
}
