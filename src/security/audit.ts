import type { BetterSqliteDatabase } from '../db/connection.js';

/**
 * C7 agent audit log store.
 *
 * Append-only audit records for agent write actions (create post / comment /
 * reply). Captures the acting agent actor, its workspace, the action, the
 * resulting target id, the root post id (for comments/replies), the
 * idempotency key used (if any), and a timestamp. The log is read by the
 * machine-readable status metadata surface and by admin tooling (C9+).
 *
 * This module owns ONLY audit storage. The agent service writes audit records
 * as part of each agent write action.
 */

/** An agent write action recorded in the audit log. */
export type AgentWriteAction = 'create_post' | 'create_comment' | 'create_reply';

/** A stored audit log row. */
export interface AgentAuditRow {
  id: number;
  actorId: string;
  workspaceId: string;
  action: AgentWriteAction;
  targetId: string;
  rootPostId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export class AgentAuditRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /** Append an audit record. Returns the inserted row id. */
  record(input: {
    actorId: string;
    workspaceId: string;
    action: AgentWriteAction;
    targetId: string;
    rootPostId?: string;
    idempotencyKey?: string;
  }): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO agent_audit_log (
           actor_id, workspace_id, action, target_id,
           root_post_id, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actorId,
        input.workspaceId,
        input.action,
        input.targetId,
        input.rootPostId ?? null,
        input.idempotencyKey ?? null,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  /** List audit records for an actor, newest first. */
  listForActor(actorId: string, limit = 100): AgentAuditRow[] {
    return this.db
      .prepare(
        `SELECT id, actor_id AS actorId, workspace_id AS workspaceId, action,
                target_id AS targetId, root_post_id AS rootPostId,
                idempotency_key AS idempotencyKey, created_at AS createdAt
         FROM agent_audit_log
         WHERE actor_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(actorId, limit) as AgentAuditRow[];
  }

  /** List audit records for a workspace, newest first. */
  listForWorkspace(workspaceId: string, limit = 100): AgentAuditRow[] {
    return this.db
      .prepare(
        `SELECT id, actor_id AS actorId, workspace_id AS workspaceId, action,
                target_id AS targetId, root_post_id AS rootPostId,
                idempotency_key AS idempotencyKey, created_at AS createdAt
         FROM agent_audit_log
         WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as AgentAuditRow[];
  }
}
