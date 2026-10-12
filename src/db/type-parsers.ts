import pg from "pg";

/**
 * Deliberate conversions for PostgreSQL types whose default node-postgres handling is unsafe here.
 *
 * - BIGINT (int8) defaults to a string. Counters and sequence values are bounded far below 2^53,
 *   so they are converted to numbers, and any value outside the safe-integer range fails loudly
 *   instead of silently losing precision.
 * - DATE defaults to a JavaScript Date at local midnight, which shifts calendar dates by the host
 *   time zone. Usage months are calendar dates, so they stay as "YYYY-MM-DD" strings.
 *
 * Applied per connection (pool and migration client), never by mutating pg's global registry.
 */

type TypeId = Parameters<typeof pg.types.getTypeParser>[0];
type TypeFormat = Parameters<typeof pg.types.getTypeParser>[1];
type TypeParser = (value: string) => unknown;

const { builtins } = pg.types;

export function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`BIGINT value ${value} is outside the JavaScript safe integer range`);
  }
  return parsed;
}

function keepDateString(value: string): string {
  return value;
}

function getTypeParser(oid: TypeId, format?: TypeFormat): TypeParser {
  if (format !== "binary") {
    if (oid === builtins.INT8) {
      return parseSafeInteger;
    }
    if (oid === builtins.DATE) {
      return keepDateString;
    }
  }
  // pg-types declares its parsers as `any`; they are the library's own text/binary parsers.
  return pg.types.getTypeParser(oid, format) as TypeParser;
}

export const typeParsers: pg.CustomTypesConfig = { getTypeParser };
