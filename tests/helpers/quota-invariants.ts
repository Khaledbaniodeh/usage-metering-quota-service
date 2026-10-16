import {
  countInvariantViolations,
  noViolations,
  type QuotaInvariant,
} from "../../load/lib/invariant-queries.js";
import { withTestClient } from "./test-database.js";

/**
 * Direct SQL checks of the quota invariants over the whole test database. The queries live in
 * load/lib/invariant-queries.ts, shared with the load-test checker, so these tests exercise exactly
 * the SQL that runs after every load test.
 */
export { noViolations, type QuotaInvariant };

/** Violation counts per invariant; all zero when the stored state is consistent. */
export async function checkQuotaInvariants(): Promise<Record<QuotaInvariant, number>> {
  return withTestClient((client) => countInvariantViolations(client));
}

/** Tries to change and delete stored decisions; each attempt must be refused by the database. */
export async function decisionHistoryRejectsChanges(): Promise<{
  readonly update: string | undefined;
  readonly delete: string | undefined;
}> {
  return withTestClient(async (client) => {
    const attempt = async (sql: string) => {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await client.query("ROLLBACK");
      }
    };
    return {
      update: await attempt("UPDATE consume_decisions SET units = units"),
      delete: await attempt("DELETE FROM consume_decisions"),
    };
  });
}
