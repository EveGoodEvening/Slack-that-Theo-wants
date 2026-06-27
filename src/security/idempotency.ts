import { createHash } from 'node:crypto';
import type { BetterSqliteDatabase } from '../db/connection.js';
import type { AgentWriteAction } from './audit.js';

/**
 * C7 agent idempotency key store.
 *
 * Durable idempotency for agent writes. A client-supplied idempotency key
 * (scoped per actor + action) records the resulting target id and a digest of
 * the request payload. A replayed write with the same key returns the original
 * target id instead of creating a duplicate — and therefore does NOT trigger a
 * second feed bump. This is the durable backstop for retry/replay safety on
 * agent create-post/comment/reply calls.
 *
 * The store is keyed by `(key, actor_id, action)`; the same key reused for a
 * different action or actor is a separate entry. A request digest guards
 * against a client reusing a key with a different payload (mismatch returns
 * the stored target but flags the conflict so the service can reject).
 */

/** The result of an idempotency lookup. */
export interface IdempotencyRecord {
  key: string;
  actorId: string;
  workspaceId: string;
  action: AgentWriteAction;
  targetId: string;
  requestDigest: string;
  createdAt: string;
}

/** Compute a short stable digest of a request payload string. */
export function requestDigest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export class AgentIdempotencyRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /**
   * Look up an existing idempotency record. Returns undefined if the key has
   * not been used for this actor + action.
   */
  lookup(
    key: string,
    actorId: string,
    action: AgentWriteAction,
  ): IdempotencyRecord | undefined {
    return this.db
      .prepare(
        `SELECT key, actor_id AS actorId, workspace_id AS workspaceId, action,
                target_id AS targetId, request_digest AS requestDigest,
                created_at AS createdAt
         FROM agent_idempotency_key
         WHERE key = ? AND actor_id = ? AND action = ?`,
      )
      .get(key, actorId, action) as IdempotencyRecord | undefined;
  }

  /**
   * Store a new idempotency record. Throws if the key already exists for this
   * actor + action (the PRIMARY KEY enforces this). Callers should `lookup`
   * first and return the stored result on a replay.
   */
  store(input: {
    key: string;
    actorId: string;
    workspaceId: string;
    action: AgentWriteAction;
    targetId: string;
    requestDigest: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_idempotency_key (key, actor_id, workspace_id, action, target_id, request_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.key,
        input.actorId,
        input.workspaceId,
        input.action,
        input.targetId,
        input.requestDigest,
        new Date().toISOString(),
      );
  }
}
