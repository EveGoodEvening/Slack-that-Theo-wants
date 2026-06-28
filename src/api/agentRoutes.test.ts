import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import {
  appliedMigrations,
  migrateDown,
  migrateUp,
  migrations,
  type BetterSqliteDatabase,
} from '../db/index.js';
import { DomainRepository } from '../domain/index.js';
import {
  AgentAuditRepository,
  AgentCredentialRepository,
  AgentIdempotencyRepository,
  AgentProfileRepository,
  AgentQuotaRepository,
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_SCHEME,
  MembershipRepository,
  DEFAULT_AGENT_QUOTA,
  QuotaExceededError,
  requestDigest,
  verifySecret,
  AuthRepository,
} from '../security/index.js';
import { createApp, type AppDeps } from '../index.js';
import { AgentService, IDEMPOTENCY_HEADER } from './agentService.js';
import { CommentServiceImpl } from './commentService.js';
import { PostServiceImpl } from './postService.js';

/**
 * C7 agent control-plane API tests.
 *
 * Covers the plan's "Required verification":
 * - an agent actor can create a reply and the post bumps exactly as a human
 *   reply does
 * - agent credentials are scoped (cannot act outside its workspace/group)
 * - an agent can retrieve machine-readable priority/status metadata and infer
 *   ordering/activity without scraping UI text
 * - credentials are stored hashed and the secret is shown only once at issuance
 * - credential rotation issues a new one-time secret, rejects the old secret,
 *   and retains only hashed credential material
 * - revoked credentials are rejected
 * - audit records are emitted for each agent create-post, create-comment, and
 *   create-reply action
 * - rate-limit/quota enforcement rejects excess agent writes and does not
 *   create duplicate writes or extra bumps when limits are exceeded
 * - a replayed agent write with the same idempotency key does not create a
 *   duplicate reply or extra bump
 * - agent feed/event/status metadata is redacted to least-privilege (no
 *   cross-workspace leakage)
 * - migration 0003 apply/rollback for the C7 persistent security structures
 */

let db: BetterSqliteDatabase;
let domain: DomainRepository;
let membership: MembershipRepository;
let credentials: AgentCredentialRepository;
let auth: AuthRepository;
let profiles: AgentProfileRepository;
let audit: AgentAuditRepository;
let idempotency: AgentIdempotencyRepository;
let quota: AgentQuotaRepository;

beforeAll(() => {
  db = openDatabase(':memory:');
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  let applied = appliedMigrations(db);
  while (applied.length > 0) {
    const latest = expectArrayItem(applied, applied.length - 1);
    migrateDown(db, migrations, latest);
    applied = appliedMigrations(db);
  }
  migrateUp(db, migrations);
  domain = new DomainRepository(db);
  membership = new MembershipRepository(db);
  auth = new AuthRepository(db);
  credentials = new AgentCredentialRepository(db);
  profiles = new AgentProfileRepository(db);
  audit = new AgentAuditRepository(db);
  idempotency = new AgentIdempotencyRepository(db);
  quota = new AgentQuotaRepository(db);
});

function app(): Hono {
  const deps: AppDeps = { repository: domain, membership, auth, db };
  return createApp(deps);
}

/** Two-workspace fixture: wsA and wsB, each with one human and one agent. */
function twoWorkspaceFixture() {
  domain.createWorkspace({ id: 'wsA', slug: 'team-a', name: 'Team A' });
  domain.createWorkspace({ id: 'wsB', slug: 'team-b', name: 'Team B' });
  domain.createActor({ id: 'humanA', workspaceId: 'wsA', kind: 'human', displayName: 'Ada' });
  domain.createActor({ id: 'agentA', workspaceId: 'wsA', kind: 'agent', displayName: 'AgentA' });
  domain.createActor({ id: 'humanB', workspaceId: 'wsB', kind: 'human', displayName: 'Bob' });
  domain.createActor({ id: 'agentB', workspaceId: 'wsB', kind: 'agent', displayName: 'AgentB' });
  profiles.create({ actorId: 'agentA', description: 'Agent A' });
  profiles.create({ actorId: 'agentB', description: 'Agent B' });
}

function bearerToken(secret: string): Record<string, string> {
  return { [AGENT_TOKEN_HEADER]: `${AGENT_TOKEN_SCHEME} ${secret}` };
}

function idempotencyHeader(key: string): Record<string, string> {
  return { [IDEMPOTENCY_HEADER]: key };
}

function expectArrayItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  expect(item).toBeDefined();
  if (item === undefined) {
    throw new Error(`expected array item at index ${index}`);
  }
  return item;
}

function expectLivePost(post: ReturnType<DomainRepository['getPost']>) {
  expect(post).toBeDefined();
  if (post === undefined || 'isDeleted' in post) {
    throw new Error('expected live post');
  }
  return post;
}

function expectLiveComment(comment: ReturnType<DomainRepository['getComment']>) {
  expect(comment).toBeDefined();
  if (comment === undefined || 'isDeleted' in comment) {
    throw new Error('expected live comment');
  }
  return comment;
}

async function issueCredentialViaApi(
  appInstance: Hono,
  secret: string,
  label?: string,
): Promise<{ id: string; secret: string }> {
  const res = await appInstance.request('/agents/credentials', {
    method: 'POST',
    headers: { ...bearerToken(secret), 'content-type': 'application/json' },
    body: JSON.stringify(label ? { label } : {}),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; secret: string };
}

// ---------------------------------------------------------------------------

describe('C7 migration 0003 apply/rollback', () => {
  it('applies and rolls back the agent control-plane tables cleanly', () => {
    // After beforeEach the migration is applied. Verify tables exist.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('agent_profile');
    expect(names).toContain('agent_credential');
    expect(names).toContain('agent_audit_log');
    expect(names).toContain('agent_idempotency_key');
    expect(names).toContain('agent_quota_state');

    // Roll back migration 0003.
    migrateDown(db, migrations, 3);
    const after = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'",
      )
      .all() as { name: string }[];
    expect(after).toHaveLength(0);

    // Re-apply for the rest of the suite (beforeEach re-applies anyway).
    migrateUp(db, migrations);
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent credential lifecycle', () => {
  it('issues a credential with a one-time secret stored hashed (never plaintext)', () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA', label: 'prod' });
    expect(issued.secret).toMatch(/^sttw_agent_/);
    expect(issued.id).toBeTruthy();

    // The stored row must NOT contain the plaintext secret.
    const rows = credentials.listForActor('agentA');
    expect(rows).toHaveLength(1);
    const row = expectArrayItem(rows, 0);
    expect(row.secretHash).not.toContain(issued.secret);
    expect(row.status).toBe('active');
    expect(row.label).toBe('prod');

    // The hash must verify against the plaintext but not match it.
    expect(verifySecret(issued.secret, row.secretHash)).toBe(true);
  });

  it('verifies an active credential and resolves to the agent actor + workspace', () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const verified = credentials.verify(issued.secret);
    expect(verified).toBeDefined();
    expect(verified?.actorId).toBe('agentA');
    expect(verified?.workspaceId).toBe('wsA');
  });

  it('rotation issues a new one-time secret and rejects the old secret', () => {
    twoWorkspaceFixture();
    const first = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const rotated = credentials.rotate({ actorId: 'agentA', workspaceId: 'wsA' });

    expect(rotated.secret).not.toBe(first.secret);
    expect(rotated.id).not.toBe(first.id);

    // Old secret is now rejected.
    expect(credentials.verify(first.secret)).toBeUndefined();
    // New secret verifies.
    const verified = credentials.verify(rotated.secret);
    expect(verified?.actorId).toBe('agentA');

    // Only hashed material is retained: no plaintext in any row.
    const rows = credentials.listForActor('agentA');
    for (const row of rows) {
      expect(row.secretHash).not.toContain(first.secret);
      expect(row.secretHash).not.toContain(rotated.secret);
    }
    // The old credential is revoked.
    const oldRow = rows.find((r) => r.id === first.id);
    expect(oldRow?.status).toBe('revoked');
  });

  it('revoked credentials are rejected on verify', () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const revoked = credentials.revoke(issued.id);
    expect(revoked).toBe(1);
    expect(credentials.verify(issued.secret)).toBeUndefined();
  });

  it('revokeAllForActor revokes every active credential', () => {
    twoWorkspaceFixture();
    credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const count = credentials.revokeAllForActor('agentA');
    expect(count).toBe(2);
    const rows = credentials.listForActor('agentA');
    for (const row of rows) {
      expect(row.status).toBe('revoked');
    }
  });

  it('a credential cannot be issued for a human actor (FK / trigger guard)', () => {
    twoWorkspaceFixture();
    expect(() =>
      credentials.issue({ actorId: 'humanA', workspaceId: 'wsA' }),
    ).toThrow();
  });

  it('a credential cannot be issued for a workspace where the agent is not a member', () => {
    twoWorkspaceFixture();
    expect(() =>
      credentials.issue({ actorId: 'agentA', workspaceId: 'wsB' }),
    ).toThrow();
  });

  it('a credential issued in a shared workspace inherits that workspace scope', async () => {
    twoWorkspaceFixture();
    membership.createShare({
      workspaceId: 'wsB',
      actorId: 'agentA',
      role: 'write',
      sharedByActorId: 'humanB',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsB' });
    expect(credentials.verify(issued.secret)?.workspaceId).toBe('wsB');

    const res = await app().request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        [IDEMPOTENCY_HEADER]: 'shared-ws-post',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'shared workspace agent post' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { result: { workspaceId: string; authorActorId: string } };
    expect(body.result.workspaceId).toBe('wsB');
    expect(body.result.authorActorId).toBe('agentA');
    const feed = await app().request('/agents/feed', {
      headers: bearerToken(issued.secret),
    });
    expect(feed.status).toBe(200);
    const page = (await feed.json()) as { posts: { workspaceId: string }[] };
    expect(page.posts.every((post) => post.workspaceId === 'wsB')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent principal resolution (Bearer token)', () => {
  it('rejects a request with no Authorization header', async () => {
    twoWorkspaceFixture();
    const res = await app().request('/agents/feed');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('missing_principal');
  });

  it('rejects a revoked credential', async () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    credentials.revoke(issued.id);
    const res = await app().request('/agents/feed', {
      headers: bearerToken(issued.secret),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header (wrong scheme)', async () => {
    twoWorkspaceFixture();
    const res = await app().request('/agents/feed', {
      headers: { [AGENT_TOKEN_HEADER]: 'Basic abc' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent write: create post', () => {
  it('an agent can create a post through the agent API', async () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('create-post'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'agent post' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      result: { id: string; content: string; authorActorId: string };
      replay: boolean;
    };
    expect(body.result.content).toBe('agent post');
    expect(body.result.authorActorId).toBe('agentA');
    expect(body.replay).toBe(false);
  });

  it('rejects agent writes without an idempotency key', async () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/posts', {
      method: 'POST',
      headers: { ...bearerToken(issued.secret), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'agent post' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('missing_idempotency_key');
  });

  it('emits an audit record for create-post', async () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('audit-post'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'audited post' }),
    });
    const body = (await res.json()) as { result: { id: string } };
    const records = audit.listForActor('agentA');
    expect(records).toHaveLength(1);
    const record = expectArrayItem(records, 0);
    expect(record.action).toBe('create_post');
    expect(record.targetId).toBe(body.result.id);
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent reply bumps the post identically to human replies', () => {
  it('an agent reply bumps the root post lastActivityAt via the shared C1 bump helper', async () => {
    twoWorkspaceFixture();
    // Seed a post as a human with a fixed old activity time.
    const post = domain.createPost({
      id: 'post1',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'human post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const before = post.lastActivityAt;

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    // Create a first-level comment as the agent.
    const res = await app().request('/agents/posts/post1/comments', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('bump-comment'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'agent comment' }),
    });
    expect(res.status).toBe(201);

    const after = expectLivePost(domain.getPost('post1'));
    expect(after.lastActivityAt > before).toBe(true);
  });

  it('an agent reply to a comment bumps the root post exactly as a human reply does', async () => {
    twoWorkspaceFixture();
    const post = domain.createPost({
      id: 'post2',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'human post 2',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const comment = domain.createComment({
      id: 'c1',
      workspaceId: 'wsA',
      rootPostId: 'post2',
      authorActorId: 'humanA',
      content: 'human comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/comments/c1/replies', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('bump-reply'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'agent reply' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { result: { id: string; rootPostId: string } };
    expect(body.result.rootPostId).toBe('post2');

    const after = expectLivePost(domain.getPost('post2'));
    expect(after.lastActivityAt > post.lastActivityAt).toBe(true);
    expect(after.lastActivityAt > comment.createdAt).toBe(true);

    // The agent reply is a real comment_node row authored by the agent.
    const reply = expectLiveComment(domain.getComment(body.result.id));
    expect(reply.authorActorId).toBe('agentA');
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent credentials are workspace-scoped', () => {
  it('an agent cannot act outside its workspace (cross-workspace write rejected)', async () => {
    twoWorkspaceFixture();
    // Seed a post in wsB.
    domain.createPost({
      id: 'postB',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    // agentA is in wsA; it must not comment on a wsB post. Per the C7 redaction
    // contract, cross-workspace access is translated to a generic 404 not_found
    // so the target workspace's existence is not leaked (same as read paths).
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/posts/postB/comments', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('cross-ws'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'cross-ws comment' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('not_found');
    // No workspace identifier leaks and the write was not performed.
    expect(body.error).not.toContain('wsB');
    expect(body.error).not.toContain('wsA');
    expect(JSON.stringify(body)).not.toContain('workspace_mismatch');
    expect(domain.countCommentsForPost('postB')).toBe(0);
  });

  it('an agent cannot read feed/status from another workspace', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'postB',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB secret post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const feedRes = await app().request('/agents/feed', {
      headers: bearerToken(issued.secret),
    });
    const feedBody = (await feedRes.json()) as { posts: { id: string }[] };
    expect(feedBody.posts.map((p) => p.id)).not.toContain('postB');

    const statusRes = await app().request('/agents/status', {
      headers: bearerToken(issued.secret),
    });
    const statusBody = (await statusRes.json()) as { posts: { id: string }[] };
    expect(statusBody.posts.map((p) => p.id)).not.toContain('postB');
  });
});

// ---------------------------------------------------------------------------

describe('C7 machine-readable priority/status metadata', () => {
  it('returns per-post lastActivityAt, reply counts, status, and actor type ordered by activity', async () => {
    twoWorkspaceFixture();
    // Two posts; the older one gets a comment so it should sort first.
    domain.createPost({
      id: 'pOld',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'old',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createPost({
      id: 'pNew',
      workspaceId: 'wsA',
      authorActorId: 'agentA',
      content: 'newer',
      lastActivityAt: '2026-01-02T00:00:00.000Z',
    });
    // Bump pOld via a comment.
    domain.createComment({
      id: 'cOld',
      workspaceId: 'wsA',
      rootPostId: 'pOld',
      authorActorId: 'humanA',
      content: 'bump',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/status', {
      headers: bearerToken(issued.secret),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      posts: {
        id: string;
        lastActivityAt: string;
        replyCount: number;
        firstLevelCount: number;
        status: string;
        authorKind: string;
      }[];
    };
    // Activity-ordered: pOld (bumped to Jan 3) before pNew (Jan 2).
    const firstPost = expectArrayItem(body.posts, 0);
    const secondPost = expectArrayItem(body.posts, 1);
    expect(firstPost.id).toBe('pOld');
    expect(secondPost.id).toBe('pNew');
    // Metadata contract fields.
    expect(firstPost.replyCount).toBe(1);
    expect(firstPost.firstLevelCount).toBe(1);
    expect(firstPost.status).toBe('active');
    expect(firstPost.authorKind).toBe('human');
    expect(secondPost.authorKind).toBe('agent');
  });

  it('readStatus returns a single post metadata entry', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'p1',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'x',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/status/p1', {
      headers: bearerToken(issued.secret),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; replyCount: number; authorKind: string };
    expect(body.id).toBe('p1');
    expect(body.replyCount).toBe(0);
    expect(body.authorKind).toBe('human');
  });
});

// ---------------------------------------------------------------------------

describe('C7 audit logging for agent write actions', () => {
  it('emits audit records for create-post, create-comment, and create-reply', async () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });

    const postRes = await app().request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('audit-create-post'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'post' }),
    });
    const postBody = (await postRes.json()) as { result: { id: string } };

    const commentRes = await app().request(`/agents/posts/${postBody.result.id}/comments`, {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('audit-create-comment'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'comment' }),
    });
    const commentBody = (await commentRes.json()) as { result: { id: string } };

    const replyRes = await app().request(`/agents/comments/${commentBody.result.id}/replies`, {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('audit-create-reply'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'reply' }),
    });
    expect(replyRes.status).toBe(201);

    const records = audit.listForActor('agentA');
    expect(records).toHaveLength(3);
    expect(expectArrayItem(records, 0).action).toBe('create_reply');
    expect(expectArrayItem(records, 1).action).toBe('create_comment');
    expect(expectArrayItem(records, 2).action).toBe('create_post');
  });

  it('the agent can read its own audit log via GET /agents/audit', async () => {
    twoWorkspaceFixture();
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    await app().request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('audit-log-post'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'post' }),
    });
    const res = await app().request('/agents/audit', {
      headers: bearerToken(issued.secret),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: { action: string; targetId: string }[] };
    expect(body.actions).toHaveLength(1);
    expect(expectArrayItem(body.actions, 0).action).toBe('create_post');
  });

  it('/agents/audit is scoped to the credential workspace for multi-workspace agents', async () => {
    twoWorkspaceFixture();
    membership.createShare({
      workspaceId: 'wsB',
      actorId: 'agentA',
      role: 'write',
      sharedByActorId: 'humanB',
    });
    const issuedA = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const issuedB = credentials.issue({ actorId: 'agentA', workspaceId: 'wsB' });
    const a = app();

    const postA = await a.request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issuedA.secret),
        ...idempotencyHeader('audit-scope-a'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'workspace A audit row' }),
    });
    expect(postA.status).toBe(201);
    const postB = await a.request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issuedB.secret),
        ...idempotencyHeader('audit-scope-b'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'workspace B audit row' }),
    });
    expect(postB.status).toBe(201);

    const auditA = await a.request('/agents/audit', { headers: bearerToken(issuedA.secret) });
    expect(auditA.status).toBe(200);
    const bodyA = (await auditA.json()) as { actions: { idempotencyKey: string | null }[] };
    expect(bodyA.actions).toHaveLength(1);
    expect(expectArrayItem(bodyA.actions, 0).idempotencyKey).toBe('audit-scope-a');

    const auditB = await a.request('/agents/audit', { headers: bearerToken(issuedB.secret) });
    expect(auditB.status).toBe(200);
    const bodyB = (await auditB.json()) as { actions: { idempotencyKey: string | null }[] };
    expect(bodyB.actions).toHaveLength(1);
    expect(expectArrayItem(bodyB.actions, 0).idempotencyKey).toBe('audit-scope-b');
  });
});

// ---------------------------------------------------------------------------

describe('C7 rate-limit / quota enforcement', () => {
  it('rejects excess agent writes with 429 and does not create a duplicate write or extra bump', async () => {
    twoWorkspaceFixture();
    // Use a tiny quota so we can exceed it immediately.
    const svc = new AgentService({
      repository: domain,
      postService: new PostServiceImpl(domain),
      commentService: new CommentServiceImpl(domain),
      credentials,
      profiles,
      audit,
      idempotency,
      quota,
      quotaConfig: { maxCount: 1, windowMs: 60_000 },
    });

    // First write succeeds.
    const r1 = svc.createPost({
      principal: { actorId: 'agentA', workspaceId: 'wsA', kind: 'agent', role: 'write' },
      content: 'first',
    });
    expect(r1.replay).toBe(false);

    // Second write in the same window is rejected.
    expect(() =>
      svc.createPost({
        principal: { actorId: 'agentA', workspaceId: 'wsA', kind: 'agent', role: 'write' },
        content: 'second',
      }),
    ).toThrow(QuotaExceededError);

    // Only one post was created (no duplicate write).
    const posts = domain.listPostsInWorkspace('wsA', 100);
    expect(posts.map((p) => p.content)).toContain('first');
    expect(posts.map((p) => p.content)).not.toContain('second');
  });

  it('the HTTP surface maps quota errors to 429', async () => {
    twoWorkspaceFixture();
    // Pre-consume the quota so the HTTP write is rejected.
    for (let i = 0; i < DEFAULT_AGENT_QUOTA.maxCount; i += 1) {
      quota.checkAndConsume('agentA', 'wsA', DEFAULT_AGENT_QUOTA);
    }
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('quota-rejected'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'should be rejected' }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('quota_exceeded');
  });
});

// ---------------------------------------------------------------------------

describe('C7 idempotency: no duplicate reply or extra bump on replay', () => {
  it('a replayed agent write with the same key does not create a duplicate or extra bump', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pIdem',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const key = 'idem-key-1';
    const headers = {
      ...bearerToken(issued.secret),
      ...idempotencyHeader(key),
      'content-type': 'application/json',
    };

    // First write.
    const r1 = await app().request('/agents/posts/pIdem/comments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'agent comment' }),
    });
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { result: { id: string }; replay: boolean };
    expect(b1.replay).toBe(false);
    const firstTargetId = b1.result.id;

    const firstActivity = expectLivePost(domain.getPost('pIdem')).lastActivityAt;

    // Replay with the same key.
    const r2 = await app().request('/agents/posts/pIdem/comments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'agent comment' }),
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { result: { id: string }; replay: boolean };
    expect(b2.replay).toBe(true);
    expect(b2.result.id).toBe(firstTargetId);

    // No duplicate comment was created: only one comment_node under the post.
    expect(domain.countCommentsForPost('pIdem')).toBe(1);

    // No extra bump: the post activity did not change.
    const secondActivity = expectLivePost(domain.getPost('pIdem')).lastActivityAt;
    expect(secondActivity).toBe(firstActivity);

    // Only one audit record (the replay did not audit).
    const records = audit.listForActor('agentA');
    expect(records).toHaveLength(1);
  });

  it('a replayed agent reply does not create a duplicate reply or extra bump', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pIdem2',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const comment = domain.createComment({
      id: 'cIdem2',
      workspaceId: 'wsA',
      rootPostId: 'pIdem2',
      authorActorId: 'humanA',
      content: 'comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const key = 'idem-reply-1';
    const headers = {
      ...bearerToken(issued.secret),
      ...idempotencyHeader(key),
      'content-type': 'application/json',
    };

    const r1 = await app().request('/agents/comments/cIdem2/replies', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'agent reply' }),
    });
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { result: { id: string }; replay: boolean };
    const firstId = b1.result.id;

    const r2 = await app().request('/agents/comments/cIdem2/replies', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'agent reply' }),
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { result: { id: string }; replay: boolean };
    expect(b2.result.id).toBe(firstId);
    expect(b2.replay).toBe(true);

    // Only one reply node under the comment's post beyond the seeded comment.
    expect(domain.countCommentsForPost('pIdem2')).toBe(2);
  });

  it('scopes the same idempotency key and action independently by workspace', async () => {
    twoWorkspaceFixture();
    membership.createShare({
      workspaceId: 'wsB',
      actorId: 'agentA',
      role: 'write',
      sharedByActorId: 'humanB',
    });
    const issuedA = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const issuedB = credentials.issue({ actorId: 'agentA', workspaceId: 'wsB' });
    const key = 'same-key-two-workspaces';
    const a = app();

    const resA = await a.request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issuedA.secret),
        ...idempotencyHeader(key),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'workspace A idempotent post' }),
    });
    expect(resA.status).toBe(201);
    const bodyA = (await resA.json()) as { result: { id: string; workspaceId: string } };

    const resB = await a.request('/agents/posts', {
      method: 'POST',
      headers: {
        ...bearerToken(issuedB.secret),
        ...idempotencyHeader(key),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'workspace B idempotent post' }),
    });
    expect(resB.status).toBe(201);
    const bodyB = (await resB.json()) as { result: { id: string; workspaceId: string } };

    expect(bodyA.result.workspaceId).toBe('wsA');
    expect(bodyB.result.workspaceId).toBe('wsB');
    expect(bodyB.result.id).not.toBe(bodyA.result.id);
    expect(idempotency.lookup(key, 'agentA', 'wsA', 'create_post')?.targetId).toBe(bodyA.result.id);
    expect(idempotency.lookup(key, 'agentA', 'wsB', 'create_post')?.targetId).toBe(bodyB.result.id);
  });
});

// ---------------------------------------------------------------------------

describe('C7 metadata redaction / least-privilege (no cross-workspace leakage)', () => {
  it('the agent feed excludes posts from other workspaces', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pA',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'wsA post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createPost({
      id: 'pB',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/feed', {
      headers: bearerToken(issued.secret),
    });
    const body = (await res.json()) as { posts: { id: string; workspaceId: string }[] };
    expect(body.posts.map((p) => p.id)).toContain('pA');
    expect(body.posts.map((p) => p.id)).not.toContain('pB');
    for (const p of body.posts) {
      expect(p.workspaceId).toBe('wsA');
    }
  });

  it('the agent status metadata excludes posts from other workspaces', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pA2',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'wsA',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createPost({
      id: 'pB2',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/status', {
      headers: bearerToken(issued.secret),
    });
    const body = (await res.json()) as { posts: { id: string; workspaceId: string }[] };
    expect(body.posts.map((p) => p.id)).toContain('pA2');
    expect(body.posts.map((p) => p.id)).not.toContain('pB2');
    for (const p of body.posts) {
      expect(p.workspaceId).toBe('wsA');
    }
  });

  it('readStatus on a cross-workspace post is a redacted 404 with no workspace details', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pB3',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/status/pB3', {
      headers: bearerToken(issued.secret),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('not_found');
    // No workspace identifier leaks: the response is generic.
    expect(body.error).not.toContain('wsB');
    expect(body.error).not.toContain('wsA');
    expect(JSON.stringify(body)).not.toContain('workspace_mismatch');
  });

  it('readPost on a cross-workspace post is a redacted 404 with no workspace details', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pB4',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/posts/pB4', {
      headers: bearerToken(issued.secret),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('not_found');
    expect(body.error).not.toContain('wsB');
    expect(JSON.stringify(body)).not.toContain('workspace_mismatch');
  });
});

// ---------------------------------------------------------------------------

describe('C7 redaction parity: true not-found vs cross-workspace are indistinguishable', () => {
  // The redaction contract requires that a guessed cross-workspace id yields a
  // response with the same JSON shape, status, and error string as a genuinely
  // absent id, so an attacker cannot infer whether the target exists in another
  // workspace. These tests assert byte-for-byte parity of the {error, code}
  // body and status across the status / read-post / subtree / thread paths.

  async function expectGenericNotFound(
    res: Response,
  ): Promise<{ code: string; error: string }> {
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('not_found');
    expect(body.error).toBe('not found');
    // No id, workspace, or internal code leaks.
    expect(JSON.stringify(body)).not.toContain('workspace_mismatch');
    expect(JSON.stringify(body)).not.toMatch(/ws[AB]/);
    return body;
  }

  it('GET /agents/status/:postId: true missing vs cross-workspace are identical', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pBparity',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const headers = bearerToken(issued.secret);

    const missing = await app().request('/agents/status/does-not-exist', { headers });
    const cross = await app().request('/agents/status/pBparity', { headers });

    const missingBody = await expectGenericNotFound(missing);
    const crossBody = await expectGenericNotFound(cross);
    expect(crossBody).toEqual(missingBody);
  });

  it('GET /agents/posts/:postId: true missing vs cross-workspace are identical', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pBparity2',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const headers = bearerToken(issued.secret);

    const missing = await app().request('/agents/posts/does-not-exist', { headers });
    const cross = await app().request('/agents/posts/pBparity2', { headers });

    const missingBody = await expectGenericNotFound(missing);
    const crossBody = await expectGenericNotFound(cross);
    expect(crossBody).toEqual(missingBody);
  });

  it('GET /agents/comments/:id/subtree: true missing vs cross-workspace are identical', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pBparity3',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createComment({
      id: 'cBparity3',
      workspaceId: 'wsB',
      rootPostId: 'pBparity3',
      authorActorId: 'humanB',
      content: 'wsB comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const headers = bearerToken(issued.secret);

    const missing = await app().request('/agents/comments/does-not-exist/subtree', { headers });
    const cross = await app().request('/agents/comments/cBparity3/subtree', { headers });

    const missingBody = await expectGenericNotFound(missing);
    const crossBody = await expectGenericNotFound(cross);
    expect(crossBody).toEqual(missingBody);
  });

  it('GET /agents/posts/:postId/thread: true missing vs cross-workspace are identical', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pBparity4',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const headers = bearerToken(issued.secret);

    const missing = await app().request('/agents/posts/does-not-exist/thread', { headers });
    const cross = await app().request('/agents/posts/pBparity4/thread', { headers });

    const missingBody = await expectGenericNotFound(missing);
    const crossBody = await expectGenericNotFound(cross);
    expect(crossBody).toEqual(missingBody);
  });

  it('POST /agents/posts/:postId/comments: true missing vs cross-workspace write are identical', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pBparity5',
      workspaceId: 'wsB',
      authorActorId: 'humanB',
      content: 'wsB',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const headers = {
      ...bearerToken(issued.secret),
      'content-type': 'application/json',
    };

    const missing = await app().request('/agents/posts/does-not-exist/comments', {
      method: 'POST',
      headers: { ...headers, ...idempotencyHeader('parity-missing') },
      body: JSON.stringify({ content: 'x' }),
    });
    const cross = await app().request('/agents/posts/pBparity5/comments', {
      method: 'POST',
      headers: { ...headers, ...idempotencyHeader('parity-cross') },
      body: JSON.stringify({ content: 'x' }),
    });

    const missingBody = await expectGenericNotFound(missing);
    const crossBody = await expectGenericNotFound(cross);
    expect(crossBody).toEqual(missingBody);
    // Neither write was performed.
    expect(domain.countCommentsForPost('does-not-exist')).toBe(0);
    expect(domain.countCommentsForPost('pBparity5')).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('C7 credential lifecycle via the HTTP API', () => {
  it('POST /agents/credentials issues a one-time secret and the agent can use it', async () => {
    twoWorkspaceFixture();
    // Bootstrap: issue directly so the agent has a usable credential.
    const bootstrap = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const issued = await issueCredentialViaApi(app(), bootstrap.secret, 'new');
    expect(issued.secret).toMatch(/^sttw_agent_/);
    // The new credential is usable.
    const feedRes = await app().request('/agents/feed', {
      headers: bearerToken(issued.secret),
    });
    expect(feedRes.status).toBe(200);
  });

  it('POST /agents/credentials/rotate issues a new secret and rejects the old one', async () => {
    twoWorkspaceFixture();
    const first = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/credentials/rotate', {
      method: 'POST',
      headers: { ...bearerToken(first.secret), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const rotated = (await res.json()) as { secret: string };
    expect(rotated.secret).not.toBe(first.secret);

    // Old secret rejected.
    const oldRes = await app().request('/agents/feed', {
      headers: bearerToken(first.secret),
    });
    expect(oldRes.status).toBe(401);
    // New secret works.
    const newRes = await app().request('/agents/feed', {
      headers: bearerToken(rotated.secret),
    });
    expect(newRes.status).toBe(200);
  });

  it('POST /agents/credentials/revoke revokes all active credentials', async () => {
    twoWorkspaceFixture();
    const first = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/credentials/revoke', {
      method: 'POST',
      headers: bearerToken(first.secret),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: number };
    expect(body.revoked).toBe(1);
    // The credential is now rejected.
    const after = await app().request('/agents/feed', {
      headers: bearerToken(first.secret),
    });
    expect(after.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent profile', () => {
  it('an agent profile can only reference an agent actor', () => {
    twoWorkspaceFixture();
    expect(() => profiles.create({ actorId: 'humanA' })).toThrow();
  });

  it('profile status can be updated', () => {
    twoWorkspaceFixture();
    const updated = profiles.setStatus('agentA', 'suspended');
    expect(updated?.status).toBe('suspended');
  });
});

// ---------------------------------------------------------------------------

describe('C7 idempotency: reject replay with a different payload', () => {
  it('reusing a key with different content is rejected with 422 and no write/bump', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pIdemMismatch',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const key = 'idem-mismatch-1';
    const headers = {
      ...bearerToken(issued.secret),
      ...idempotencyHeader(key),
      'content-type': 'application/json',
    };

    // First write with the key.
    const r1 = await app().request('/agents/posts/pIdemMismatch/comments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'agent comment' }),
    });
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { result: { id: string }; replay: boolean };
    expect(b1.replay).toBe(false);
    const firstTargetId = b1.result.id;

    const firstActivity = expectLivePost(domain.getPost('pIdemMismatch')).lastActivityAt;
    const firstAuditCount = audit.listForActor('agentA').length;

    // Reuse the same key with DIFFERENT content: rejected, no replay.
    const r2 = await app().request('/agents/posts/pIdemMismatch/comments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'different content' }),
    });
    expect(r2.status).toBe(422);
    const b2 = (await r2.json()) as { code: string; error: string };
    expect(b2.code).toBe('idempotency_key_reuse');

    // No new comment was created: the count is still one.
    expect(domain.countCommentsForPost('pIdemMismatch')).toBe(1);
    void firstTargetId;

    // No extra bump: post activity unchanged.
    const secondActivity = expectLivePost(domain.getPost('pIdemMismatch')).lastActivityAt;
    expect(secondActivity).toBe(firstActivity);

    // No new audit record was appended for the rejected replay.
    expect(audit.listForActor('agentA').length).toBe(firstAuditCount);
  });

  it('reusing a reply key with a different parent/content is rejected with 422', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pIdemReplyMismatch',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createComment({
      id: 'cIdemReplyMismatch',
      workspaceId: 'wsA',
      rootPostId: 'pIdemReplyMismatch',
      authorActorId: 'humanA',
      content: 'comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const key = 'idem-reply-mismatch-1';
    const headers = {
      ...bearerToken(issued.secret),
      ...idempotencyHeader(key),
      'content-type': 'application/json',
    };

    const r1 = await app().request('/agents/comments/cIdemReplyMismatch/replies', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'agent reply' }),
    });
    expect(r1.status).toBe(201);

    // Reuse the key with different content: rejected.
    const r2 = await app().request('/agents/comments/cIdemReplyMismatch/replies', {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'changed reply' }),
    });
    expect(r2.status).toBe(422);
    const b2 = (await r2.json()) as { code: string };
    expect(b2.code).toBe('idempotency_key_reuse');

    // Only the first reply was created (seeded comment + one reply).
    expect(domain.countCommentsForPost('pIdemReplyMismatch')).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('C7 rate-limit rolling-window enforcement', () => {
  it('enforces a true rolling window across a boundary (not a fixed bucket)', () => {
    twoWorkspaceFixture();
    const cfg = { maxCount: 1, windowMs: 60_000 };
    const t0 = new Date('2026-06-27T00:00:00.000Z');

    // Consume the single allowed write at t0.
    expect(quota.checkAndConsume('agentA', 'wsA', cfg, t0)).toBe(1);

    // 30s later, still inside the rolling window: rejected.
    const t30 = new Date(t0.getTime() + 30_000);
    expect(() => quota.checkAndConsume('agentA', 'wsA', cfg, t30)).toThrow(QuotaExceededError);

    // 1ms before the window expires: still rejected. The window is
    // (now − windowMs, now]; at t0+59999 that is (−1, 59999], which still
    // includes the t0 write (0 > −1), so the quota is exhausted.
    const tJustBefore = new Date(t0.getTime() + 59_999);
    expect(() => quota.checkAndConsume('agentA', 'wsA', cfg, tJustBefore)).toThrow(QuotaExceededError);

    // Exactly 60s after: the t0 write has aged out of the window
    // (windowStart = 60000 − 60000 = 0; occurred_at > 0 excludes t0=0), so a
    // new write is allowed.
    const t60 = new Date(t0.getTime() + 60_000);
    expect(quota.checkAndConsume('agentA', 'wsA', cfg, t60)).toBe(1);
  });

  it('allows up to maxCount writes within the window and rejects the next', () => {
    twoWorkspaceFixture();
    const cfg = { maxCount: 3, windowMs: 60_000 };
    const t0 = new Date('2026-06-27T00:00:00.000Z');
    expect(quota.checkAndConsume('agentA', 'wsA', cfg, t0)).toBe(1);
    expect(quota.checkAndConsume('agentA', 'wsA', cfg, new Date(t0.getTime() + 1_000))).toBe(2);
    expect(quota.checkAndConsume('agentA', 'wsA', cfg, new Date(t0.getTime() + 2_000))).toBe(3);
    expect(() =>
      quota.checkAndConsume('agentA', 'wsA', cfg, new Date(t0.getTime() + 3_000)),
    ).toThrow(QuotaExceededError);
  });

  it('currentCount reports the rolling-window count and does not consume', () => {
    twoWorkspaceFixture();
    const cfg = { maxCount: 5, windowMs: 60_000 };
    const t0 = new Date('2026-06-27T00:00:00.000Z');
    quota.checkAndConsume('agentA', 'wsA', cfg, t0);
    quota.checkAndConsume('agentA', 'wsA', cfg, new Date(t0.getTime() + 10_000));
    // Two writes in the window.
    expect(quota.currentCount('agentA', new Date(t0.getTime() + 20_000), cfg.windowMs)).toBe(2);
    // After the window passes, the count ages out to zero.
    expect(quota.currentCount('agentA', new Date(t0.getTime() + 70_000), cfg.windowMs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('C7 agent deleted-parent reply mapping', () => {
  it('POST /agents/comments/:parentId/replies on a soft-deleted parent returns 409 deleted_parent', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pDelParent',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createComment({
      id: 'cDelParent',
      workspaceId: 'wsA',
      rootPostId: 'pDelParent',
      authorActorId: 'humanA',
      content: 'comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    // Soft-delete the parent comment so replies into it are rejected.
    domain.softDeleteComment('cDelParent', '2026-01-03T00:00:00.000Z');

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/comments/cDelParent/replies', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('reply-into-deleted'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'late agent reply' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('deleted_parent');

    // No reply was created. countCommentsForPost counts only live nodes, and
    // the seeded parent is soft-deleted, so the live count is 0; verify via the
    // raw subtree that no child node was appended under the deleted parent.
    expect(domain.countCommentsForPost('pDelParent')).toBe(0);
    const subtree = domain.getSubtree('cDelParent');
    expect(subtree).toHaveLength(1);
    expect(expectArrayItem(subtree, 0).node.id).toBe('cDelParent');
  });

  it('POST /agents/comments/:parentId/replies below a deleted root post returns 409 deleted_parent', async () => {
    twoWorkspaceFixture();
    domain.createPost({
      id: 'pDelRoot',
      workspaceId: 'wsA',
      authorActorId: 'humanA',
      content: 'post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    domain.createComment({
      id: 'cDelRoot',
      workspaceId: 'wsA',
      rootPostId: 'pDelRoot',
      authorActorId: 'humanA',
      content: 'comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    // Soft-delete the root post so the comment is in a deleted subtree.
    domain.softDeletePost('pDelRoot', '2026-01-03T00:00:00.000Z');

    const issued = credentials.issue({ actorId: 'agentA', workspaceId: 'wsA' });
    const res = await app().request('/agents/comments/cDelRoot/replies', {
      method: 'POST',
      headers: {
        ...bearerToken(issued.secret),
        ...idempotencyHeader('reply-into-deleted-root'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'late agent reply' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('deleted_parent');
  });
});

// ---------------------------------------------------------------------------

describe('C7 idempotency store digest', () => {
  it('requestDigest is stable for the same payload and differs for different payloads', () => {
    const a = requestDigest('abc');
    const b = requestDigest('abc');
    const c = requestDigest('abd');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
