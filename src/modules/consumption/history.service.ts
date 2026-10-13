import type { Queryable } from "../../db/pool.js";
import type { Clock } from "../../shared/clock.js";
import { decodeCursor, encodeCursor, invalidCursor } from "../../shared/cursor.js";
import { futureMonth } from "../../shared/query-params.js";
import { isFutureMonth, monthStartOf } from "../../shared/utc-month.js";
import { userNotFound } from "../users/users.service.js";
import type { ConsumeDecision } from "./consume.domain.js";
import { checkHistoryRequest, listHistoryPage } from "./history.repository.js";

export interface HistoryRequest {
  readonly userId?: string | undefined;
  /** `YYYY-MM`. */
  readonly month?: string | undefined;
  readonly cursor?: string | undefined;
  /** Validated page size (1-100). */
  readonly limit: number;
}

export interface HistoryPage {
  /** The effective filters, including those taken from a cursor. */
  readonly userId: string | null;
  readonly month: string | null;
  readonly decisions: ConsumeDecision[];
  readonly nextCursor: string | null;
}

export interface HistoryService {
  readonly listHistory: (accountId: string, request: HistoryRequest) => Promise<HistoryPage>;
}

export interface HistoryServiceDependencies {
  readonly db: Queryable;
  readonly clock: Clock;
}

interface EffectiveRequest {
  readonly userId: string | null;
  readonly month: string | null;
  readonly anchor: string | null;
}

/**
 * The effective filters and anchor of a history request. A cursor binds its filters: a request
 * may omit them (they come from the cursor) or repeat them exactly, but not change them.
 * Precedence: an explicit future month first, then every cursor problem as "Invalid cursor".
 */
function resolveRequest(request: HistoryRequest, clock: Clock): EffectiveRequest {
  const requestedUser = request.userId?.toLowerCase();
  let now: Date | undefined;
  const isFuture = (month: string) => isFutureMonth(month, (now ??= clock()));

  if (request.month !== undefined && isFuture(request.month)) {
    throw futureMonth();
  }
  if (request.cursor === undefined) {
    return { userId: requestedUser ?? null, month: request.month ?? null, anchor: null };
  }
  const cursor = decodeCursor("history", request.cursor);
  const matches =
    (requestedUser === undefined || requestedUser === cursor.userId) &&
    (request.month === undefined || request.month === cursor.month) &&
    (cursor.month === null || !isFuture(cursor.month));
  if (!matches) {
    throw invalidCursor();
  }
  return { userId: cursor.userId, month: cursor.month, anchor: cursor.anchor };
}

export function createHistoryService({ db, clock }: HistoryServiceDependencies): HistoryService {
  return {
    listHistory: async (accountId, request) => {
      const { userId, month, anchor } = resolveRequest(request, clock);
      const filters = { userId, monthStart: month === null ? null : monthStartOf(month) };

      let beforeSeq: number | undefined;
      if (userId !== null || anchor !== null) {
        const checks = await checkHistoryRequest(db, accountId, filters, anchor);
        if (!checks.userFound) {
          throw userNotFound();
        }
        if (anchor !== null) {
          if (checks.anchorSeq === undefined) {
            throw invalidCursor();
          }
          beforeSeq = checks.anchorSeq;
        }
      }

      // One extra row tells whether another page exists.
      const rows = await listHistoryPage(db, accountId, filters, beforeSeq, request.limit + 1);
      const page = rows.slice(0, request.limit);
      const last = page.at(-1);
      return {
        userId,
        month,
        decisions: page.map((row) => row.decision),
        nextCursor:
          rows.length > request.limit && last !== undefined
            ? encodeCursor({ kind: "history", anchor: last.id, userId, month })
            : null,
      };
    },
  };
}
