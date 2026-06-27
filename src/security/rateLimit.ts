import type { BetterSqliteDatabase } from '../db/connection.js';

/**
 * C7 agent rate-limit / quota store.
 *
 * Per-actor rolling-window (sliding-window) write quota. Each consumed write
 * is recorded as a timestamped event in `agent_quota_state`; a check counts
 * the events whose timestamp falls strictly within the last `windowMs`
 * milliseconds and rejects with a quota error when the configured limit would
 * be exceeded. Because the window slides continuously (it is not a fixed
 * wall-clock bucket), an agent cannot concentrate up to 2x the quota across a
 * bucket boundary — at every instant the count of writes in the trailing
 * `windowMs` is bounded by `maxCount`.
 *
 * The count-then-insert runs inside a synchronous better-sqlite3 transaction
 * so the check and the consume are atomic with respect to other callers. Old
 * events are not cleaned eagerly; they simply age out of the window and stop
 * being counted. The agent service calls `checkAndConsume` before each agent
 * write and rejects excess writes without creating the write (and therefore
 * without an extra feed bump).
 */

/** A quota configuration: max writes per window. */
export interface QuotaConfig {
  /** Maximum writes allowed within one rolling window. */
  maxCount: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Default per-minute write quota for agents. */
export const DEFAULT_AGENT_QUOTA: QuotaConfig = {
  maxCount: 60,
  windowMs: 60_000,
};

/** Thrown when an agent has exceeded its write quota for the current window. */
export class QuotaExceededError extends Error {
  readonly actorId: string;
  readonly windowMs: number;
  readonly limit: number;

  constructor(actorId: string, windowMs: number, limit: number) {
    super(
      `agent ${actorId} exceeded write quota (${limit}) in the last ${windowMs}ms`,
    );
    this.name = 'QuotaExceededError';
    this.actorId = actorId;
    this.windowMs = windowMs;
    this.limit = limit;
  }
}

export class AgentQuotaRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /**
   * Check and consume one unit of quota for the actor under the given config.
   * Counts writes whose timestamp is strictly within the last `windowMs`
   * milliseconds (a true rolling window). Throws `QuotaExceededError` if the
   * count is already at the limit; otherwise records the write and returns the
   * count after consuming. The count + insert is wrapped in a transaction so
   * concurrent callers cannot both observe room and both insert.
   */
  checkAndConsume(
    actorId: string,
    workspaceId: string,
    config: QuotaConfig,
    at: Date = new Date(),
  ): number {
    const now = at.getTime();
    const windowStart = now - config.windowMs;
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM agent_quota_state WHERE actor_id = ? AND occurred_at > ?',
        )
        .get(actorId, windowStart) as { n: number } | undefined;
      const count = row?.n ?? 0;
      if (count >= config.maxCount) {
        throw new QuotaExceededError(actorId, config.windowMs, config.maxCount);
      }
      this.db
        .prepare(
          'INSERT INTO agent_quota_state (actor_id, workspace_id, occurred_at) VALUES (?, ?, ?)',
        )
        .run(actorId, workspaceId, now);
      return count + 1;
    })();
  }

  /** Read the current rolling-window count without consuming. */
  currentCount(actorId: string, at: Date, windowMs: number): number {
    const now = at.getTime();
    const windowStart = now - windowMs;
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM agent_quota_state WHERE actor_id = ? AND occurred_at > ?',
      )
      .get(actorId, windowStart) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}
