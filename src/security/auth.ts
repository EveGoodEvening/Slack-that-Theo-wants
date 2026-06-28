import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { BetterSqliteDatabase } from '../db/connection.js';
import type { Role } from './types.js';

/**
 * C9 local auth/session primitives.
 *
 * The MVP deliberately stays boring: email + password identities for existing
 * human actors, opaque server-side sessions, HttpOnly SameSite cookies for the
 * server-rendered UI, and an Authorization Bearer fallback for non-browser API
 * clients. OAuth / SSO is out of scope for C9.
 */

export const SESSION_COOKIE_NAME = 'sttw_session';
export const SESSION_TOKEN_SCHEME = 'Bearer';

const SESSION_SECRET_PREFIX = 'sttw_session_';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export interface AuthIdentityRow {
  id: string;
  actorId: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRow {
  id: string;
  actorId: string;
  workspaceId: string;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface IssuedSession {
  id: string;
  secret: string;
  actorId: string;
  workspaceId: string;
  expiresAt: string;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export function generateSessionSecret(): string {
  return SESSION_SECRET_PREFIX + randomBytes(32).toString('base64url');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashSessionSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function sessionCookie(secret: string, expiresAt?: string): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (expiresAt !== undefined) {
    attributes.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  }
  return attributes.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export interface SessionPrincipalRequest {
  header(name: string): string | undefined;
}

export function sessionSecretFromRequest(
  request: SessionPrincipalRequest,
): string | undefined {
  const authorization = request.header('authorization');
  if (authorization !== undefined) {
    const trimmed = authorization.trim();
    const prefix = `${SESSION_TOKEN_SCHEME} `;
    if (trimmed.startsWith(prefix)) {
      const token = trimmed.slice(prefix.length).trim();
      if (token.startsWith(SESSION_SECRET_PREFIX)) return token;
    }
  }

  const cookie = request.header('cookie');
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== SESSION_COOKIE_NAME) continue;
    const encoded = rawValue.join('=');
    if (encoded.length === 0) return undefined;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return undefined;
}

export class AuthRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  createIdentity(input: {
    actorId: string;
    email: string;
    password: string;
  }): AuthIdentityRow {
    const id = cryptoId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_identity (id, actor_id, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.actorId,
        normalizeEmail(input.email),
        hashPassword(input.password),
        now,
        now,
      );
    const created = this.getIdentityByEmail(input.email);
    if (created === undefined) {
      throw new Error(`createIdentity: identity for ${input.email} did not persist`);
    }
    return created;
  }

  getIdentityByEmail(email: string): AuthIdentityRow | undefined {
    return this.db
      .prepare(
        `SELECT id, actor_id AS actorId, email, password_hash AS passwordHash,
                created_at AS createdAt, updated_at AS updatedAt
         FROM auth_identity
         WHERE email = ? COLLATE NOCASE`,
      )
      .get(normalizeEmail(email)) as AuthIdentityRow | undefined;
  }

  setPassword(input: { actorId: string; password: string }): void {
    const result = this.db
      .prepare(
        `UPDATE auth_identity
         SET password_hash = ?, updated_at = ?
         WHERE actor_id = ?`,
      )
      .run(hashPassword(input.password), new Date().toISOString(), input.actorId);
    if (result.changes !== 1) {
      throw new AuthenticationError(`actor ${input.actorId} has no auth identity`);
    }
  }

  authenticate(input: {
    email: string;
    password: string;
    workspaceId?: string;
    ttlMs?: number;
  }): IssuedSession {
    const identity = this.getIdentityByEmail(input.email);
    if (identity === undefined || !verifyPassword(input.password, identity.passwordHash)) {
      throw new AuthenticationError('invalid email or password');
    }
    const workspaceId = input.workspaceId ?? this.defaultWorkspaceForActor(identity.actorId);
    if (workspaceId === undefined) {
      throw new AuthenticationError('actor has no active workspace membership');
    }
    const request: { actorId: string; workspaceId: string; ttlMs?: number } = {
      actorId: identity.actorId,
      workspaceId,
    };
    if (input.ttlMs !== undefined) request.ttlMs = input.ttlMs;
    return this.createSession(request);
  }

  createSession(input: {
    actorId: string;
    workspaceId: string;
    ttlMs?: number;
  }): IssuedSession {
    const membership = this.db
      .prepare(
        `SELECT role
         FROM workspace_member
         WHERE actor_id = ? AND workspace_id = ? AND status = 'active'`,
      )
      .get(input.actorId, input.workspaceId) as { role: Role } | undefined;
    if (membership === undefined) {
      throw new AuthenticationError(
        `actor ${input.actorId} is not an active member of workspace ${input.workspaceId}`,
      );
    }

    const id = cryptoId();
    const secret = generateSessionSecret();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS),
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_session (id, actor_id, workspace_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.actorId,
        input.workspaceId,
        hashSessionSecret(secret),
        now.toISOString(),
        expiresAt,
      );
    return { id, secret, actorId: input.actorId, workspaceId: input.workspaceId, expiresAt };
  }

  resolveSession(secret: string, now = new Date()): AuthSessionRow | undefined {
    if (!secret.startsWith(SESSION_SECRET_PREFIX)) return undefined;
    const row = this.db
      .prepare(
        `SELECT id, actor_id AS actorId, workspace_id AS workspaceId,
                secret_hash AS secretHash, created_at AS createdAt,
                expires_at AS expiresAt, revoked_at AS revokedAt
         FROM auth_session
         WHERE secret_hash = ? AND revoked_at IS NULL`,
      )
      .get(hashSessionSecret(secret)) as AuthSessionRow | undefined;
    if (row === undefined) return undefined;
    if (row.expiresAt <= now.toISOString()) return undefined;
    return row;
  }

  revokeSession(secret: string): number {
    return this.db
      .prepare(
        `UPDATE auth_session
         SET revoked_at = ?
         WHERE secret_hash = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), hashSessionSecret(secret)).changes;
  }

  private defaultWorkspaceForActor(actorId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT workspace_id AS workspaceId
         FROM workspace_member
         WHERE actor_id = ? AND status = 'active'
         ORDER BY created_at ASC, workspace_id ASC
         LIMIT 1`,
      )
      .get(actorId) as { workspaceId: string } | undefined;
    return row?.workspaceId;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return randomBytes(16).toString('hex');
}
