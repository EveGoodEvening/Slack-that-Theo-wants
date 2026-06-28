import { randomBytes } from 'node:crypto';
import type { BetterSqliteDatabase } from '../db/connection.js';
import type { ActorKind } from '../domain/types.js';
import type { Role } from './types.js';

/** C9 membership, invite, and share lifecycle primitives. */

export type MembershipStatus = 'invited' | 'active' | 'suspended';
export type InviteStatus = 'pending' | 'accepted' | 'revoked';
export type ShareStatus = 'active' | 'revoked';

/** A membership row: the durable shape stored in `workspace_member`. */
export interface MembershipRow {
  workspaceId: string;
  actorId: string;
  role: Role;
  status: MembershipStatus;
  invitedByActorId: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

/** Resolved active membership used to build a Principal: actor + role. */
export interface ResolvedMembership {
  actorId: string;
  workspaceId: string;
  kind: ActorKind;
  displayName: string;
  role: Role;
}

export interface WorkspaceInviteRow {
  id: string;
  workspaceId: string;
  email: string;
  role: Role;
  status: InviteStatus;
  invitedByActorId: string | null;
  tokenHash: string | null;
  acceptedByActorId: string | null;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface WorkspaceShareRow {
  id: string;
  workspaceId: string;
  actorId: string;
  role: Role;
  status: ShareStatus;
  sharedByActorId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export class MembershipRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /** Look up a membership row regardless of lifecycle status. */
  getMembership(
    workspaceId: string,
    actorId: string,
  ): MembershipRow | undefined {
    return this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, actor_id AS actorId, role, status,
                invited_by_actor_id AS invitedByActorId,
                created_at AS createdAt, updated_at AS updatedAt,
                accepted_at AS acceptedAt
         FROM workspace_member
         WHERE workspace_id = ? AND actor_id = ?`,
      )
      .get(workspaceId, actorId) as MembershipRow | undefined;
  }

  /** Resolve only active memberships into principals. */
  resolveMembership(
    workspaceId: string,
    actorId: string,
  ): ResolvedMembership | undefined {
    return this.db
      .prepare(
        `SELECT m.workspace_id AS workspaceId, m.actor_id AS actorId,
                m.role, a.kind, a.display_name AS displayName
         FROM workspace_member m
         JOIN actor a ON a.id = m.actor_id
         WHERE m.workspace_id = ?
           AND m.actor_id = ?
           AND m.status = 'active'`,
      )
      .get(workspaceId, actorId) as ResolvedMembership | undefined;
  }

  /** List every active workspace the actor is a member of. */
  listMembershipsForActor(actorId: string): MembershipRow[] {
    return this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, actor_id AS actorId, role, status,
                invited_by_actor_id AS invitedByActorId,
                created_at AS createdAt, updated_at AS updatedAt,
                accepted_at AS acceptedAt
         FROM workspace_member
         WHERE actor_id = ? AND status = 'active'
         ORDER BY created_at ASC, workspace_id ASC`,
      )
      .all(actorId) as MembershipRow[];
  }

  /** List every active member of a workspace. */
  listMembersInWorkspace(workspaceId: string): MembershipRow[] {
    return this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, actor_id AS actorId, role, status,
                invited_by_actor_id AS invitedByActorId,
                created_at AS createdAt, updated_at AS updatedAt,
                accepted_at AS acceptedAt
         FROM workspace_member
         WHERE workspace_id = ? AND status = 'active'
         ORDER BY created_at ASC, actor_id ASC`,
      )
      .all(workspaceId) as MembershipRow[];
  }

  /** Upsert an active membership role. */
  setMembership(
    workspaceId: string,
    actorId: string,
    role: Role,
  ): MembershipRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_member (
           workspace_id, actor_id, role, status, created_at, updated_at, accepted_at
         ) VALUES (?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (workspace_id, actor_id) DO UPDATE SET
           role = excluded.role,
           status = 'active',
           updated_at = excluded.updated_at,
           accepted_at = COALESCE(workspace_member.accepted_at, excluded.accepted_at)`,
      )
      .run(workspaceId, actorId, role, now, now, now);
    return this.requireMembership(workspaceId, actorId);
  }

  inviteMember(input: {
    workspaceId: string;
    actorId: string;
    role: Role;
    invitedByActorId?: string;
  }): MembershipRow {
    const existing = this.getMembership(input.workspaceId, input.actorId);
    if (existing?.status === 'active') {
      const role = strongestRole(existing.role, input.role);
      return role === existing.role
        ? existing
        : this.setMembership(input.workspaceId, input.actorId, role);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_member (
           workspace_id, actor_id, role, status, invited_by_actor_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'invited', ?, ?, ?)
         ON CONFLICT (workspace_id, actor_id) DO UPDATE SET
           role = excluded.role,
           status = 'invited',
           invited_by_actor_id = excluded.invited_by_actor_id,
           updated_at = excluded.updated_at,
           accepted_at = NULL`,
      )
      .run(
        input.workspaceId,
        input.actorId,
        input.role,
        input.invitedByActorId ?? null,
        now,
        now,
      );
    return this.requireMembership(input.workspaceId, input.actorId);
  }

  acceptMembership(workspaceId: string, actorId: string): MembershipRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workspace_member
         SET status = 'active', updated_at = ?, accepted_at = COALESCE(accepted_at, ?)
         WHERE workspace_id = ? AND actor_id = ?`,
      )
      .run(now, now, workspaceId, actorId);
    return this.requireMembership(workspaceId, actorId);
  }

  suspendMembership(workspaceId: string, actorId: string): MembershipRow {
    this.db
      .prepare(
        `UPDATE workspace_member
         SET status = 'suspended', updated_at = ?
         WHERE workspace_id = ? AND actor_id = ?`,
      )
      .run(new Date().toISOString(), workspaceId, actorId);
    return this.requireMembership(workspaceId, actorId);
  }

  removeMembership(workspaceId: string, actorId: string): number {
    return this.db
      .prepare('DELETE FROM workspace_member WHERE workspace_id = ? AND actor_id = ?')
      .run(workspaceId, actorId).changes;
  }

  createInvite(input: {
    workspaceId: string;
    email: string;
    role: Role;
    invitedByActorId?: string;
    tokenHash?: string;
    id?: string;
  }): WorkspaceInviteRow {
    const id = input.id ?? cryptoId();
    this.db
      .prepare(
        `INSERT INTO workspace_invite (
           id, workspace_id, email, role, status, invited_by_actor_id, token_hash
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.email.trim().toLowerCase(),
        input.role,
        input.invitedByActorId ?? null,
        input.tokenHash ?? null,
      );
    return this.requireInvite(id);
  }

  acceptInvite(inviteId: string, actorId: string): WorkspaceInviteRow {
    const invite = this.requireInvite(inviteId);
    if (invite.status !== 'pending') {
      throw new Error(`invite ${inviteId} is not pending`);
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE workspace_invite
         SET status = 'accepted', accepted_by_actor_id = ?, accepted_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(actorId, now, inviteId);
    if (result.changes !== 1) {
      throw new Error(`invite ${inviteId} could not be accepted`);
    }
    const existing = this.getMembership(invite.workspaceId, actorId);
    const role =
      existing?.status === 'active'
        ? strongestRole(existing.role, invite.role)
        : invite.role;
    this.setMembership(invite.workspaceId, actorId, role);
    return this.requireInvite(inviteId);
  }

  revokeInvite(inviteId: string): WorkspaceInviteRow {
    const invite = this.requireInvite(inviteId);
    if (invite.status !== 'pending') {
      throw new Error(`invite ${inviteId} is not pending`);
    }
    const result = this.db
      .prepare(
        `UPDATE workspace_invite
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), inviteId);
    if (result.changes !== 1) {
      throw new Error(`invite ${inviteId} could not be revoked`);
    }
    return this.requireInvite(inviteId);
  }

  createShare(input: {
    workspaceId: string;
    actorId: string;
    role: Role;
    sharedByActorId?: string;
    id?: string;
  }): WorkspaceShareRow {
    const id = input.id ?? cryptoId();
    this.db
      .prepare(
        `INSERT INTO workspace_share (
           id, workspace_id, actor_id, role, status, shared_by_actor_id
         ) VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.actorId,
        input.role,
        input.sharedByActorId ?? null,
      );
    const existing = this.getMembership(input.workspaceId, input.actorId);
    const role =
      existing?.status === 'active'
        ? strongestRole(existing.role, input.role)
        : input.role;
    this.setMembership(input.workspaceId, input.actorId, role);
    return this.requireShare(id);
  }

  revokeShare(shareId: string): WorkspaceShareRow {
    const share = this.requireShare(shareId);
    if (share.status !== 'active') {
      return share;
    }
    const result = this.db
      .prepare(
        `UPDATE workspace_share
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), shareId);
    if (result.changes !== 1) {
      throw new Error(`share ${shareId} could not be revoked`);
    }

    const home = this.db
      .prepare('SELECT workspace_id AS workspaceId FROM actor WHERE id = ?')
      .get(share.actorId) as { workspaceId: string } | undefined;
    if (home !== undefined && home.workspaceId !== share.workspaceId) {
      const inviteRole = this.acceptedInviteRole(share.workspaceId, share.actorId);
      if (inviteRole === undefined) {
        this.removeMembership(share.workspaceId, share.actorId);
      } else {
        this.setMembership(share.workspaceId, share.actorId, inviteRole);
      }
    }
    return this.requireShare(shareId);
  }

  private acceptedInviteRole(workspaceId: string, actorId: string): Role | undefined {
    const row = this.db
      .prepare(
        `SELECT role
         FROM workspace_invite
         WHERE workspace_id = ?
           AND accepted_by_actor_id = ?
           AND status = 'accepted'
         ORDER BY CASE role WHEN 'write' THEN 0 ELSE 1 END,
                  accepted_at DESC, created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(workspaceId, actorId) as { role: Role } | undefined;
    return row?.role;
  }

  private requireMembership(workspaceId: string, actorId: string): MembershipRow {
    const row = this.getMembership(workspaceId, actorId);
    if (row === undefined) {
      throw new Error(`membership (${workspaceId}, ${actorId}) did not persist`);
    }
    return row;
  }

  private requireInvite(id: string): WorkspaceInviteRow {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, email, role, status,
                invited_by_actor_id AS invitedByActorId,
                token_hash AS tokenHash,
                accepted_by_actor_id AS acceptedByActorId,
                created_at AS createdAt, accepted_at AS acceptedAt,
                revoked_at AS revokedAt
         FROM workspace_invite
         WHERE id = ?`,
      )
      .get(id) as WorkspaceInviteRow | undefined;
    if (row === undefined) throw new Error(`invite ${id} did not persist`);
    return row;
  }

  private requireShare(id: string): WorkspaceShareRow {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, actor_id AS actorId, role,
                status, shared_by_actor_id AS sharedByActorId,
                created_at AS createdAt, revoked_at AS revokedAt
         FROM workspace_share
         WHERE id = ?`,
      )
      .get(id) as WorkspaceShareRow | undefined;
    if (row === undefined) throw new Error(`share ${id} did not persist`);
    return row;
  }
}

function strongestRole(a: Role, b: Role): Role {
  return a === 'write' || b === 'write' ? 'write' : 'read';
}

function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return randomBytes(16).toString('hex');
}
