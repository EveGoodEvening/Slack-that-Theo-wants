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
import { MembershipRepository } from '../security/membership.js';
import { PRINCIPAL_HEADERS } from '../security/principal.js';
import { createApp, type AppDeps } from '../index.js';
import { decodeCursor, encodeCursor } from './postService.js';

/**
 * C2 post feed API tests.
 *
 * Covers the plan's "Required verification":
 * - feed ordering follows lastActivityAt, not creation time
 * - an old post moves to the top after C1-seeded comment activity bumps its
 *   lastActivityAt (the C1 bump invariant), without the C3 reply endpoint
 * - pagination is stable when multiple posts share the same lastActivityAt
 * - cross-workspace reads/writes are rejected and feed listings exclude posts
 *   outside the principal's workspace/group
 * - empty feed state
 *
 * Comments are seeded directly through the C1 DomainRepository to verify the
 * bump, per the plan's "C2 bump verification uses C1-seeded activity" rule.
 */

let db: BetterSqliteDatabase;
let domain: DomainRepository;
let membership: MembershipRepository;

beforeAll(() => {
  db = openDatabase(':memory:');
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  let applied = appliedMigrations(db);
  while (applied.length > 0) {
    migrateDown(db, migrations, applied[applied.length - 1]);
    applied = appliedMigrations(db);
  }
  migrateUp(db, migrations);
  domain = new DomainRepository(db);
  membership = new MembershipRepository(db);
});

function app(): Hono {
  const deps: AppDeps = { repository: domain, membership };
  return createApp(deps);
}

function headersFor(actorId: string, workspaceId: string): Record<string, string> {
  return {
    [PRINCIPAL_HEADERS.actorId]: actorId,
    [PRINCIPAL_HEADERS.workspaceId]: workspaceId,
  };
}

/**
 * Two-workspace fixture: wsA and wsB, each with one human writer. The auto-
 * membership trigger gives each actor a 'write' role in its own workspace.
 */
function twoWorkspaceFixture() {
  const wsA = domain.createWorkspace({ id: 'wsA', slug: 'team-a', name: 'Team A' });
  const wsB = domain.createWorkspace({ id: 'wsB', slug: 'team-b', name: 'Team B' });
  const humanA = domain.createActor({
    id: 'humanA',
    workspaceId: wsA.id,
    kind: 'human',
    displayName: 'Ada',
  });
  const humanB = domain.createActor({
    id: 'humanB',
    workspaceId: wsB.id,
    kind: 'human',
    displayName: 'Bo',
  });
  return { wsA, wsB, humanA, humanB };
}

/** Create a post directly via the repository with a fixed lastActivityAt. */
function seedPost(
  id: string,
  workspaceId: string,
  authorActorId: string,
  content: string,
  lastActivityAt: string,
): void {
  domain.createPost({ id, workspaceId, authorActorId, content, lastActivityAt });
}

async function createPostViaApi(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ id: string; lastActivityAt: string }> {
  const res = await appInstance.request('/posts', {
    method: 'POST',
    headers: { ...headersFor(actorId, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; lastActivityAt: string };
  return body;
}

async function listFeedViaApi(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  query?: { limit?: number; cursor?: string },
): Promise<{
  posts: { id: string; lastActivityAt: string; createdAt: string }[];
  nextCursor?: string;
}> {
  const qs = new URLSearchParams();
  if (query?.limit !== undefined) qs.set('limit', String(query.limit));
  if (query?.cursor !== undefined) qs.set('cursor', query.cursor);
  const url = `/posts${qs.toString() ? `?${qs.toString()}` : ''}`;
  const res = await appInstance.request(url, {
    headers: headersFor(actorId, workspaceId),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    posts: { id: string; lastActivityAt: string; createdAt: string }[];
    nextCursor?: string;
  };
}

// ---------------------------------------------------------------------------

describe('C2 create post', () => {
  it('creates a post in the principal workspace and returns 201', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const post = await createPostViaApi(a, humanA.id, wsA.id, 'hello world');
    expect(post.id).toBeTruthy();
    expect(post.lastActivityAt).toBeTruthy();

    const read = domain.getPost(post.id);
    expect(read).toBeDefined();
    expect(read && !('isDeleted' in read) ? read?.workspaceId : undefined).toBe(wsA.id);
  });

  it('rejects empty content with 400', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts', {
      method: 'POST',
      headers: { ...headersFor(humanA.id, wsA.id), 'content-type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts', {
      method: 'POST',
      headers: headersFor(humanA.id, wsA.id),
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a read-only principal with 403 write_forbidden', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');
    const a = app();
    const res = await a.request('/posts', {
      method: 'POST',
      headers: { ...headersFor(humanA.id, wsA.id), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'no write' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('write_forbidden');
  });

  it('rejects a missing principal with 401 missing_principal', async () => {
    twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'anon' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('missing_principal');
  });
});

describe('C2 feed ordering', () => {
  it('orders the feed by lastActivityAt DESC, postId DESC — not creation time', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    // Older post has an older lastActivityAt but is created first; a newer
    // post created later must still sort below an old post whose activity was
    // bumped above it.
    seedPost('p-old', wsA.id, humanA.id, 'old', '2026-01-01T00:00:00.000Z');
    seedPost('p-new', wsA.id, humanA.id, 'new', '2026-06-01T00:00:00.000Z');
    seedPost('p-mid', wsA.id, humanA.id, 'mid', '2026-03-01T00:00:00.000Z');

    const { posts } = await listFeedViaApi(app(), humanA.id, wsA.id);
    expect(posts.map((p) => p.id)).toEqual(['p-new', 'p-mid', 'p-old']);
  });

  it('moves an old post to the top after C1-seeded comment activity bumps it', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p-old', wsA.id, humanA.id, 'old', '2026-01-01T00:00:00.000Z');
    seedPost('p-new', wsA.id, humanA.id, 'new', '2026-06-01T00:00:00.000Z');

    // Before bump: newest first.
    const before = await listFeedViaApi(app(), humanA.id, wsA.id);
    expect(before.posts.map((p) => p.id)).toEqual(['p-new', 'p-old']);

    // Seed a comment directly through the C1 repository (NOT the C3 endpoint).
    // createComment runs the shared C1 bump helper in-transaction, advancing
    // p-old's lastActivityAt to the comment's createdAt.
    domain.createComment({
      id: 'c1',
      workspaceId: wsA.id,
      rootPostId: 'p-old',
      authorActorId: humanA.id,
      content: 'a reply that bumps the old post',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const after = await listFeedViaApi(app(), humanA.id, wsA.id);
    expect(after.posts.map((p) => p.id)).toEqual(['p-old', 'p-new']);
    expect(after.posts[0]?.lastActivityAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('returns an empty feed for a workspace with no live posts', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const { posts, nextCursor } = await listFeedViaApi(app(), humanA.id, wsA.id);
    expect(posts).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });

  it('excludes soft-deleted posts from the feed', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p-live', wsA.id, humanA.id, 'live', '2026-06-01T00:00:00.000Z');
    seedPost('p-dead', wsA.id, humanA.id, 'dead', '2026-06-02T00:00:00.000Z');
    domain.softDeletePost('p-dead', '2026-06-03T00:00:00.000Z');

    const { posts } = await listFeedViaApi(app(), humanA.id, wsA.id);
    expect(posts.map((p) => p.id)).toEqual(['p-live']);
  });
});

describe('C2 feed pagination (composite cursor)', () => {
  it('paginates without duplicates or skips when posts share lastActivityAt', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    // Five posts share the same lastActivityAt; tie-break is postId DESC.
    const shared = '2026-06-01T00:00:00.000Z';
    seedPost('p1', wsA.id, humanA.id, '1', shared);
    seedPost('p2', wsA.id, humanA.id, '2', shared);
    seedPost('p3', wsA.id, humanA.id, '3', shared);
    seedPost('p4', wsA.id, humanA.id, '4', shared);
    seedPost('p5', wsA.id, humanA.id, '5', shared);

    const a = app();
    const seen: string[] = [];
    let cursor: string | undefined;
    // Page size 2.
    let page = await listFeedViaApi(a, humanA.id, wsA.id, { limit: 2 });
    expect(page.posts.map((p) => p.id)).toEqual(['p5', 'p4']);
    seen.push(...page.posts.map((p) => p.id));
    cursor = page.nextCursor;
    expect(cursor).toBeDefined();

    page = await listFeedViaApi(a, humanA.id, wsA.id, {
      limit: 2,
      cursor: cursor as string,
    });
    expect(page.posts.map((p) => p.id)).toEqual(['p3', 'p2']);
    seen.push(...page.posts.map((p) => p.id));
    cursor = page.nextCursor;
    expect(cursor).toBeDefined();

    page = await listFeedViaApi(a, humanA.id, wsA.id, {
      limit: 2,
      cursor: cursor as string,
    });
    expect(page.posts.map((p) => p.id)).toEqual(['p1']);
    seen.push(...page.posts.map((p) => p.id));
    expect(page.nextCursor).toBeUndefined();

    // No duplicates, no skips, deterministic order.
    expect(seen).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);
  });

  it('nextCursor encodes the composite (lastActivityAt, postId) of the last item', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, '1', '2026-06-01T00:00:00.000Z');
    seedPost('p2', wsA.id, humanA.id, '2', '2026-06-02T00:00:00.000Z');

    const a = app();
    const page = await listFeedViaApi(a, humanA.id, wsA.id, { limit: 1 });
    expect(page.posts.map((p) => p.id)).toEqual(['p2']);
    expect(page.nextCursor).toBeDefined();
    const decoded = decodeCursor(page.nextCursor);
    expect(decoded).toEqual({
      lastActivityAt: '2026-06-02T00:00:00.000Z',
      postId: 'p2',
    });
  });

  it('does not emit nextCursor when the first page exactly exhausts the feed', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, '1', '2026-06-01T00:00:00.000Z');
    seedPost('p2', wsA.id, humanA.id, '2', '2026-06-02T00:00:00.000Z');

    const page = await listFeedViaApi(app(), humanA.id, wsA.id, { limit: 2 });
    expect(page.posts.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects a malformed cursor with 400', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts?cursor=not-valid-base64-json', {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive limit with 400', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts?limit=0', {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(400);
  });

  it('encode/decode cursor round-trips the composite order', () => {
    const cursor = { lastActivityAt: '2026-06-01T00:00:00.000Z', postId: 'p9' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
});

describe('C2 read post', () => {
  it('returns the post plus comment-tree metadata, not the full subtree', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2026-06-01T00:00:00.000Z');
    // Seed a small tree directly via C1: two first-level comments, one reply.
    domain.createComment({
      id: 'c1',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'first',
      createdAt: '2026-06-02T00:00:00.000Z',
    });
    domain.createComment({
      id: 'c2',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'second',
      createdAt: '2026-06-03T00:00:00.000Z',
    });
    domain.createReply({
      id: 'r1',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      parentId: 'c1',
      authorActorId: humanA.id,
      content: 'reply to first',
      createdAt: '2026-06-04T00:00:00.000Z',
    });

    const a = app();
    const res = await a.request('/posts/p1', { headers: headersFor(humanA.id, wsA.id) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      post: { id: string; content: string };
      comments: { totalCount: number; firstLevelCount: number };
    };
    expect(body.post.id).toBe('p1');
    expect(body.post.content).toBe('post');
    // 3 live nodes total, 2 first-level.
    expect(body.comments.totalCount).toBe(3);
    expect(body.comments.firstLevelCount).toBe(2);
  });

  it('returns 404 for a missing post', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts/does-not-exist', {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted post', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2026-06-01T00:00:00.000Z');
    domain.softDeletePost('p1', '2026-06-02T00:00:00.000Z');
    const a = app();
    const res = await a.request('/posts/p1', { headers: headersFor(humanA.id, wsA.id) });
    expect(res.status).toBe(404);
  });

  it('metadata excludes soft-deleted comments from counts', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2026-06-01T00:00:00.000Z');
    domain.createComment({
      id: 'c1',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'first',
      createdAt: '2026-06-02T00:00:00.000Z',
    });
    domain.createComment({
      id: 'c2',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'second',
      createdAt: '2026-06-03T00:00:00.000Z',
    });
    domain.softDeleteComment('c2', '2026-06-04T00:00:00.000Z');

    const a = app();
    const res = await a.request('/posts/p1', { headers: headersFor(humanA.id, wsA.id) });
    const body = (await res.json()) as {
      comments: { totalCount: number; firstLevelCount: number };
    };
    expect(body.comments.totalCount).toBe(1);
    expect(body.comments.firstLevelCount).toBe(1);
  });
});

describe('C2 cross-workspace isolation', () => {
  it('rejects reading a post from another workspace with 403 workspace_mismatch', async () => {
    const { humanA, wsA, humanB, wsB } = twoWorkspaceFixture();
    seedPost('pB', wsB.id, humanB.id, 'b-only', '2026-06-01T00:00:00.000Z');
    const a = app();
    const res = await a.request('/posts/pB', { headers: headersFor(humanA.id, wsA.id) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('feed listing excludes posts outside the principal workspace', async () => {
    const { humanA, wsA, humanB, wsB } = twoWorkspaceFixture();
    seedPost('pA', wsA.id, humanA.id, 'a', '2026-06-01T00:00:00.000Z');
    seedPost('pB', wsB.id, humanB.id, 'b', '2026-06-02T00:00:00.000Z');

    const a = app();
    const { posts } = await listFeedViaApi(a, humanA.id, wsA.id);
    expect(posts.map((p) => p.id)).toEqual(['pA']);

    const { posts: postsB } = await listFeedViaApi(a, humanB.id, wsB.id);
    expect(postsB.map((p) => p.id)).toEqual(['pB']);
  });

  it('a write principal cannot create a post targeting another workspace via header spoof', async () => {
    // The auth middleware binds the principal to the (workspace, actor) pair in
    // the membership table; the service always writes to the principal's own
    // workspace, so a wsA actor cannot create a post in wsB.
    const { humanA, wsA, humanB, wsB } = twoWorkspaceFixture();
    const a = app();
    // humanA presents wsA headers; the created post lands in wsA, never wsB.
    const post = await createPostViaApi(a, humanA.id, wsA.id, 'a-post');
    const read = domain.getPost(post.id);
    expect(read && !('isDeleted' in read) ? read?.workspaceId : undefined).toBe(wsA.id);
    // And wsB's feed does not see it.
    const { posts } = await listFeedViaApi(a, humanB.id, wsB.id);
    expect(posts.map((p) => p.id)).toEqual([]);
  });

  it('rejects an actor presenting a workspace it is not a member of with 401', async () => {
    const { humanA, wsA, wsB } = twoWorkspaceFixture();
    const a = app();
    // humanA is a member of wsA only; presenting wsB is not a membership.
    const res = await a.request('/posts', { headers: headersFor(humanA.id, wsB.id) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('principal_not_found');
  });
});
