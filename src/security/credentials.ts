import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { BetterSqliteDatabase } from '../db/connection.js';

/**
 * C7 agent credential store.
 *
 * Scoped API tokens / service credentials for agents. Credentials are stored
 * HASHED (scrypt + per-credential salt) — the plaintext secret is NEVER
 * persisted. The plaintext is returned exactly once at issuance / rotation and
 * is never retrievable again.
 *
 * A credential is scoped to one workspace/group, and C9 validates that the
 * agent actor has an active membership in that workspace. Verification resolves
 * to the credential workspace, so the Principal inherits the current membership
 * role for that group.
 *
 * This module owns ONLY credential storage and verification. Principal
 * resolution from a verified credential is in `agentPrincipal.ts`; the audit /
 * idempotency / rate-limit stores are in their own modules.
 */

/** A stored credential row (hashed — never contains the plaintext). */
export interface AgentCredentialRow {
  id: string;
  actorId: string;
  workspaceId: string;
  secretHash: string;
  status: 'active' | 'revoked';
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** The one-time issuance result: the plaintext secret shown only at creation. */
export interface IssuedCredential {
  /** The credential id (safe to store / log). */
  id: string;
  /** The plaintext secret. Shown ONCE; never persisted, never retrievable. */
  secret: string;
  actorId: string;
  workspaceId: string;
  label: string | null;
  createdAt: string;
}

/** A credential resolved from a verified plaintext secret. */
export interface VerifiedCredential {
  id: string;
  actorId: string;
  workspaceId: string;
}

/** Secret format: `saltHex$hashHex`. scrypt parameters are fixed. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SECRET_PREFIX = 'sttw_agent_';

/** Generate a new plaintext secret. Opaque, prefixed, URL-safe. */
export function generateSecret(): string {
  const bytes = randomBytes(24);
  return SECRET_PREFIX + bytes.toString('base64url');
}

/** Hash a plaintext secret with a fresh per-credential salt. */
export function hashSecret(plaintext: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verify a plaintext secret against a stored `salt$hash` string in constant time. */
export function verifySecret(plaintext: string, stored: string): boolean {
  const sep = stored.indexOf('$');
  if (sep <= 0) return false;
  const saltHex = stored.slice(0, sep);
  const hashHex = stored.slice(sep + 1);
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export class AgentCredentialRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /**
   * Issue a new credential for an agent actor in a workspace/group. C9 schema
   * constraints require the actor to be an agent and an active member of that
   * workspace; the resolved Principal later inherits the membership role.
   */
  issue(input: {
    actorId: string;
    workspaceId: string;
    label?: string;
  }): IssuedCredential {
    const secret = generateSecret();
    const id = cryptoId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_credential (id, actor_id, workspace_id, secret_hash, status, label, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.actorId, input.workspaceId, hashSecret(secret), input.label ?? null, now);
    return {
      id,
      secret,
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      label: input.label ?? null,
      createdAt: now,
    };
  }

  /**
   * Rotate an agent's active credential: issue a new one and revoke the old.
   * Returns the new one-time plaintext secret. The old secret is rejected on
   * subsequent verify calls. Only the hashed material is retained.
   */
  rotate(input: {
    actorId: string;
    workspaceId: string;
    label?: string;
  }): IssuedCredential {
    const issued = this.issue(input);
    this.db
      .prepare(
        `UPDATE agent_credential
         SET status = 'revoked', revoked_at = ?
         WHERE actor_id = ? AND workspace_id = ? AND id <> ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), input.actorId, input.workspaceId, issued.id);
    return issued;
  }

  /** Revoke a specific credential by id. Returns the number of rows flipped. */
  revoke(credentialId: string): number {
    return this.db
      .prepare(
        `UPDATE agent_credential
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), credentialId).changes;
  }

  /** Revoke every active credential for an actor in one workspace. Returns the count revoked. */
  revokeAllForActorInWorkspace(actorId: string, workspaceId: string): number {
    return this.db
      .prepare(
        `UPDATE agent_credential
         SET status = 'revoked', revoked_at = ?
         WHERE actor_id = ? AND workspace_id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), actorId, workspaceId).changes;
  }

  /** Revoke every active credential for an actor across all workspaces. */
  revokeAllForActor(actorId: string): number {
    return this.db
      .prepare(
        `UPDATE agent_credential
         SET status = 'revoked', revoked_at = ?
         WHERE actor_id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), actorId).changes;
  }

  /**
   * Verify a plaintext secret and resolve it to the active credential's actor
   * + workspace. Returns undefined if no active credential matches (unknown,
   * revoked, or wrong secret). The lookup scans active credentials for the
   * matching hash; verification is constant-time per credential.
   */
  verify(plaintext: string): VerifiedCredential | undefined {
    if (!plaintext.startsWith(SECRET_PREFIX)) return undefined;
    const rows = this.db
      .prepare(
        `SELECT id, actor_id AS actorId, workspace_id AS workspaceId, secret_hash AS secretHash
         FROM agent_credential
         WHERE status = 'active'`,
      )
      .all() as {
      id: string;
      actorId: string;
      workspaceId: string;
      secretHash: string;
    }[];
    for (const row of rows) {
      if (verifySecret(plaintext, row.secretHash)) {
        return { id: row.id, actorId: row.actorId, workspaceId: row.workspaceId };
      }
    }
    return undefined;
  }

  /** List credential metadata (no hashes exposed beyond the stored column) for an actor. */
  listForActor(actorId: string): AgentCredentialRow[] {
    return this.db
      .prepare(
        `SELECT id, actor_id AS actorId, workspace_id AS workspaceId,
                secret_hash AS secretHash, status, label,
                created_at AS createdAt, revoked_at AS revokedAt
         FROM agent_credential
         WHERE actor_id = ?
         ORDER BY created_at DESC`,
      )
      .all(actorId) as AgentCredentialRow[];
  }
}

/** Generate a credential id. Uses crypto.randomUUID when available. */
function cryptoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return randomBytes(16).toString('hex');
}
