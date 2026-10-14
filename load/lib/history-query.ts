import type { Queryable } from "../../src/db/pool.js";
import { listHistoryPage } from "../../src/modules/consumption/history.repository.js";

/**
 * The exact SQL and parameters production sends for the first page of GET /v1/history filtered by
 * user and month, captured by calling the real repository function with a recording stub. EXPLAIN
 * therefore measures the statement the service really runs, not a hand-written copy.
 */

export interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export async function firstHistoryPageQuery(
  accountId: string,
  userId: string,
  monthKey: string,
  limit: number,
): Promise<CapturedQuery> {
  let captured: CapturedQuery | undefined;
  const recorder = {
    query: (sql: string, params: unknown[] = []) => {
      captured = { sql, params: [...params] };
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Queryable;
  // The route asks for one row more than the page size to learn whether another page exists.
  await listHistoryPage(
    recorder,
    accountId,
    { userId, monthStart: `${monthKey}-01` },
    undefined,
    limit + 1,
  );
  if (captured === undefined) {
    throw new Error("the history repository sent no query");
  }
  return captured;
}
