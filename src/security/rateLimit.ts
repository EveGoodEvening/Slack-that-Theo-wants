import type { BetterSqliteDatabase } from '../db/connection.js';

/**
 * C7 agent rate-limit / quota store.
 *
 * Per-(actor, bucket) counter enforcing a quota of agent writes within a
 * rolling time window. The bucket key encodes the window (e.g. per-minute or
 * per-hour). A check increments the counter for the current bucket and rejects
 * with a quota error when the configured limit is exceeded. Stale buckets are
 * not cleaned eagerly; the counter is reset by rotating the bucket key, so old
 * buckets simply stop being queried.
 *
 * This module owns ONLY the counter. The agent service calls `check` before
 * each agent write and rejects excess writes without creating the write (and
 * therefore without an extra feed bump).
 */

/** A quota configuration: max writes per window. */
export interface QuotaConfig {
  /** Maximum writes allowed within one window. */
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
  readonly bucketKey: string;
  readonly limit: number;

  constructor(actorId: string, bucketKey: string, limit: number) {
    super(`agent ${actorId} exceeded write quota (${limit}) for window ${bucketKey}`);
    this.name = 'QuotaExceededError';
    this.actorId = actorId;
    this.bucketKey = bucketKey;
    this.limit = limit;
  }
}

/** Compute the bucket key for a timestamp under a window. */
export function bucketKey(at: Date, windowMs: number): string {
  return String(Math.floor(at.getTime() / windowMs));
}

export class AgentQuotaRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /**
   * Check and consume one unit of quota for the actor under the given config.
   * Throws `QuotaExceededError` if the count for the current bucket would
   * exceed the limit. The increment is atomic (UPSERT + conditional update).
   * Returns the count after increment.
   */
  checkAndConsume(
    actorId: string,
    workspaceId: string,
    config: QuotaConfig,
    at: Date = new Date(),
  ): number {
    const key = bucketKey(at, config.windowMs);
    const now = at.toISOString();
    // Ensure a row exists for this bucket.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_quota_state (actor_id, workspace_id, bucket_key, count, updated_at) VALUES (?, ?, ?, 0, ?)',
      )
      .run(actorId, workspaceId, key, now);
    // Atomically increment only when under the limit.
    const info = this.db
      .prepare(
        'UPDATE agent_quota_state SET count = count + 1, updated_at = ? WHERE actor_id = ? AND bucket_key = ? AND count < ?',
      )
      .run(now, actorId, key, config.maxCount);
    if (info.changes !== 1) {
      throw new QuotaExceededError(actorId, key, config.maxCount);
    }
    const row = this.db
      .prepare('SELECT count FROM agent_quota_state WHERE actor_id = ? AND bucket_key = ?')
      .get(actorId, key) as { count: number } | undefined;
    return row?.count ?? config.maxCount;
  }

  /** Read the current count for a bucket without consuming. */
  currentCount(actorId: string, at: Date, windowMs: number): number {
    const key = bucketKey(at, windowMs);
    const row = this.db
      .prepare('SELECT count FROM agent_quota_state WHERE actor_id = ? AND bucket_key = ?')
      .get(actorId, key) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
