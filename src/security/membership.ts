import type { BetterSqliteDatabase } from '../db/connection.js';
import type { ActorKind } from '../domain/types.js';
import type { Role } from './types.js';

/**
 * C1a baseline membership repository.
 *
 * Reads the `workspace_member` table introduced by migration 0002. This is the
 * minimal model needed to scope reads and writes: an actor is a member of its
 * own workspace with a role ('read' | 'write'). The full membership lifecycle
 * (invites, shares, multi-workspace membership, role changes) is deferred to
 * C9; this repository exposes only the read path the authorization middleware
 * needs plus a small write helper for tests/seeding.
 */

/** A membership row: the durable shape stored in `workspace_member`. */
export interface MembershipRow {
  workspaceId: string;
  actorId: string;
  role: Role;
  createdAt: string;
}

/** Resolved membership used to build a Principal: actor + role. */
export interface ResolvedMembership {
  actorId: string;
  workspaceId: string;
  kind: ActorKind;
  displayName: string;
  role: Role;
}

export class MembershipRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /**
   * Look up the membership for an actor within a workspace. Returns undefined
   * if the actor does not exist or is not a member of that workspace. This is
   * the single read the principal resolver uses to authorize a request.
   */
  getMembership(
    workspaceId: string,
    actorId: string,
  ): MembershipRow | undefined {
    const row = this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, actor_id AS actorId, role,
                created_at AS createdAt
         FROM workspace_member
         WHERE workspace_id = ? AND actor_id = ?`,
      )
      .get(workspaceId, actorId) as MembershipRow | undefined;
    return row;
  }

  /**
   * Resolve an actor + workspace into a full membership (with actor kind and
   * display name) suitable for building a Principal. Returns undefined if the
   * actor is unknown or not a member of the workspace.
   */
  resolveMembership(
    workspaceId: string,
    actorId: string,
  ): ResolvedMembership | undefined {
    const row = this.db
      .prepare(
        `SELECT m.workspace_id AS workspaceId, m.actor_id AS actorId,
                m.role, a.kind, a.display_name AS displayName
         FROM workspace_member m
         JOIN actor a ON a.id = m.actor_id
         WHERE m.workspace_id = ? AND m.actor_id = ?`,
      )
      .get(workspaceId, actorId) as
      | (ResolvedMembership & { kind: ActorKind })
      | undefined;
    if (row === undefined) return undefined;
    return row;
  }

  /**
   * List every workspace the actor is a member of. Used by the scope helpers to
   * build the set of workspaces a principal can read. In the C1a baseline an
   * actor belongs to exactly one workspace; this returns that single row.
   */
  listMembershipsForActor(actorId: string): MembershipRow[] {
    const rows = this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, actor_id AS actorId, role,
                created_at AS createdAt
         FROM workspace_member
         WHERE actor_id = ?`,
      )
      .all(actorId) as MembershipRow[];
    return rows;
  }

  /**
   * List every member of a workspace. Used by the scope helpers to enumerate
   * authorized principals within a workspace (e.g. for redaction/least-
   * privilege checks in later surfaces).
   */
  listMembersInWorkspace(workspaceId: string): MembershipRow[] {
    const rows = this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, actor_id AS actorId, role,
                created_at AS createdAt
         FROM workspace_member
         WHERE workspace_id = ?`,
      )
      .all(workspaceId) as MembershipRow[];
    return rows;
  }

  /**
   * Set a membership role for an actor within its own workspace. Intended for
   * tests and C9 invite/share; C1a's auto-membership trigger already creates a
   * 'write' row on actor insert. Returns the persisted row.
   */
  setMembership(
    workspaceId: string,
    actorId: string,
    role: Role,
  ): MembershipRow {
    this.db
      .prepare(
        `INSERT INTO workspace_member (workspace_id, actor_id, role)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id, actor_id) DO UPDATE SET role = excluded.role`,
      )
      .run(workspaceId, actorId, role);
    const row = this.getMembership(workspaceId, actorId);
    if (row === undefined) {
      throw new Error(
        `setMembership: row (${workspaceId}, ${actorId}) did not persist`,
      );
    }
    return row;
  }
}
