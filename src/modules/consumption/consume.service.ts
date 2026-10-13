import { randomUUID } from "node:crypto";
import type { Queryable } from "../../db/pool.js";
import { isLockNotAvailable, isUniqueViolation } from "../../db/postgres-errors.js";
import {
  setLocalLockTimeout,
  withTransaction,
  type ConnectionSource,
} from "../../db/transaction.js";
import type { Clock } from "../../shared/clock.js";
import { AppError } from "../../shared/http-errors.js";
import { userNotFound } from "../users/users.service.js";
import {
  evaluateQuota,
  isSamePayload,
  utcMonthStart,
  type ConsumeDecision,
  type ConsumePayload,
} from "./consume.domain.js";
import {
  DECISION_REQUEST_ID_CONSTRAINT,
  ensureCounters,
  findDecision,
  incrementCounters,
  insertDecision,
  lockCounters,
  readPlanSnapshot,
} from "./consume.repository.js";

export interface ConsumeRequest extends ConsumePayload {
  readonly requestId: string;
}

export interface ConsumptionService {
  /**
   * Decides a consume request for the authenticated account and returns the stored decision.
   * Accepted and rejected decisions are both results; only invalid, foreign, conflicting or
   * timed-out requests throw.
   */
  readonly consume: (accountId: string, request: ConsumeRequest) => Promise<ConsumeDecision>;
}

export interface ConsumptionServiceDependencies {
  readonly db: Queryable & ConnectionSource;
  readonly clock: Clock;
  /** Maximum wait for a counter lock before the request is answered with 503 BUSY_RETRY. */
  readonly lockTimeoutMs: number;
}

/** Thrown inside the transaction when the request ID was decided meanwhile: forces a rollback. */
class DecisionAlreadyRecorded extends Error {
  readonly decision: ConsumeDecision;

  constructor(decision: ConsumeDecision) {
    super("A decision for this request ID was recorded concurrently");
    this.name = "DecisionAlreadyRecorded";
    this.decision = decision;
  }
}

/** The stored decision when the retry repeats its payload; otherwise 409. */
function replayOrConflict(decision: ConsumeDecision, payload: ConsumePayload): ConsumeDecision {
  if (!isSamePayload(decision, payload)) {
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "The request ID was already used with a different user or number of units",
    );
  }
  return decision;
}

export function createConsumptionService({
  db,
  clock,
  lockTimeoutMs,
}: ConsumptionServiceDependencies): ConsumptionService {
  const decideNewRequest = (
    accountId: string,
    request: ConsumeRequest,
    processedAt: Date,
    month: string,
  ): Promise<ConsumeDecision> =>
    withTransaction(db, async (client) => {
      await setLocalLockTimeout(client, lockTimeoutMs);

      // One statement: user (scoped to the account), account and both plans from one snapshot.
      const plans = await readPlanSnapshot(client, accountId, request.userId);
      if (plans === undefined) {
        throw userNotFound();
      }

      await ensureCounters(client, accountId, request.userId, month);
      const { accountUsed, userUsed } = await lockCounters(
        client,
        accountId,
        request.userId,
        month,
      );

      // Authoritative idempotency check: the account-counter lock serializes this account's month.
      const recorded = await findDecision(client, accountId, request.requestId);
      if (recorded !== undefined) {
        throw new DecisionAlreadyRecorded(recorded);
      }

      const account = { ...plans.account, usedBefore: accountUsed };
      const user = { ...plans.user, usedBefore: userUsed };
      const evaluation = evaluateQuota({ units: request.units, account, user });
      if (evaluation.accepted) {
        await incrementCounters(client, accountId, request.userId, month, request.units);
      }
      return insertDecision(client, {
        id: randomUUID(),
        accountId,
        requestId: request.requestId,
        userId: request.userId,
        units: request.units,
        accepted: evaluation.accepted,
        blockingRule: evaluation.accepted ? null : evaluation.blockingRule,
        blockingLevel: evaluation.accepted ? null : evaluation.blockingLevel,
        month,
        processedAt,
        account,
        user,
      });
    });

  return {
    consume: async (accountId, rawRequest) => {
      // UUIDs are case-insensitive; the stored (and compared) form is lower case.
      const request = { ...rawRequest, userId: rawRequest.userId.toLowerCase() };

      // Fast path: a decided request ID is answered from its record, without a new timestamp.
      const existing = await findDecision(db, accountId, request.requestId);
      if (existing !== undefined) {
        return replayOrConflict(existing, request);
      }

      const processedAt = clock();
      const month = utcMonthStart(processedAt);
      try {
        return await decideNewRequest(accountId, request, processedAt, month);
      } catch (error) {
        if (error instanceof DecisionAlreadyRecorded) {
          return replayOrConflict(error.decision, request);
        }
        if (isUniqueViolation(error, DECISION_REQUEST_ID_CONSTRAINT)) {
          // Backstop: a duplicate committed first (possibly under another month's counter lock).
          // This transaction rolled back completely; answer from the winning record.
          const winner = await findDecision(db, accountId, request.requestId);
          if (winner === undefined) {
            throw error;
          }
          return replayOrConflict(winner, request);
        }
        if (isLockNotAvailable(error)) {
          throw new AppError("BUSY_RETRY", undefined, { cause: error });
        }
        throw error;
      }
    },
  };
}
