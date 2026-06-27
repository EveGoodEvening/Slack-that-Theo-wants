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

/**
 * C3 comment/reply API tests.
 *
 * Covers the plan's "Required verification":
 * - replies at arbitrary depth insert and retrieve correctly
 * - invalid / missing parent id is rejected
 * - every nested reply bumps the root post's lastActivityAt via the shared
 *   C1 bump helper (endpoint-level, not C1-seeded)
 * - replyToActorId targeting is preserved and queryable
 * - deleted-parent behavior: replies to a soft-deleted parent are rejected and
 *   subtrees return tombstones with children preserved
 * - stable sibling ordering (createdAt ASC, id ASC) under the same parent
 * - cross-workspace reads/writes are rejected via the C1a boundary
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

function jsonHeaders(actorId: string, workspaceId: string): Record<string, string> {
  return { ...headersFor(actorId, workspaceId), 'content-type': 'application/json' };
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

/** Seed a post directly via the repository with a fixed lastActivityAt. */
function seedPost(
  id: string,
  workspaceId: string,
  authorActorId: string,
  content: string,
  lastActivityAt: string,
): void {
  domain.createPost({ id, workspaceId, authorActorId, content, lastActivityAt });
}

interface CommentBody {
  id: string;
  rootPostId: string;
  parentId: string | null;
  authorActorId: string;
  content: string;
  createdAt: string;
  replyToActorId: string | null;
  isDeleted?: true;
}

async function createCommentViaApi(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  postId: string,
  content: string,
): Promise<CommentBody> {
  const res = await appInstance.request(`/posts/${postId}/comments`, {
    method: 'POST',
    headers: jsonHeaders(actorId, workspaceId),
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CommentBody;
}


/** A reply helper that returns the full response for status assertions. */
async function replyResponse(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  parentId: string,
  content: string,
): Promise<{ status: number; body: unknown }> {
  const res = await appInstance.request(`/comments/${parentId}/replies`, {
    method: 'POST',
    headers: jsonHeaders(actorId, workspaceId),
    body: JSON.stringify({ content }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getSubtreeViaApi(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  commentId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await appInstance.request(`/comments/${commentId}/subtree`, {
    headers: headersFor(actorId, workspaceId),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getThreadViaApi(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  postId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await appInstance.request(`/posts/${postId}/thread`, {
    headers: headersFor(actorId, workspaceId),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Assert an array element exists at `index` and return it narrowed to its
 * element type. Keeps `noUncheckedIndexedAccess` happy at call sites while
 * preserving the original assertion intent (the test fails loudly if absent).
 */
function elementAt<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  expect(value).toBeDefined();
  return value as T;
}

// ---------------------------------------------------------------------------
// arbitrary-depth insertion + retrieval
// ---------------------------------------------------------------------------

describe('C3 arbitrary-depth insertion and retrieval', () => {
  it('inserts and retrieves replies at arbitrary depth (5 levels)', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'level 1');
    const r1 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, c1.id, 'level 2');
    const r2 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r1.id, 'level 3');
    const r3 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r2.id, 'level 4');
    const r4 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r3.id, 'level 5');

    const { status, body } = await getSubtreeViaApi(a, humanA.id, wsA.id, c1.id);
    expect(status).toBe(200);
    const tree = body as { root: { node: { id: string }; children: unknown[] } };
    expect(tree.root.node.id).toBe(c1.id);
    // Walk down the single-child chain to depth 5.
    let cursor: { node: { id: string }; children: unknown[] } | undefined = tree.root;
    const ids = [c1.id, r1.id, r2.id, r3.id, r4.id];
    for (const expected of ids) {
      expect(cursor?.node.id).toBe(expected);
      cursor = cursor?.children?.[0] as typeof cursor | undefined;
    }
    expect(cursor).toBeUndefined();
    // r4 is the leaf: no children.
  });

  it('returns the full thread with all first-level comments and their subtrees', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'first');
    const c2 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'second');
    const r1 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, c1.id, 'reply to first');

    const { status, body } = await getThreadViaApi(a, humanA.id, wsA.id, 'p1');
    expect(status).toBe(200);
    const thread = body as {
      postId: string;
      comments: { node: { id: string }; children: { node: { id: string } }[] }[];
    };
    expect(thread.postId).toBe('p1');
    expect(thread.comments).toHaveLength(2);
    const c1Node = elementAt(thread.comments, 0);
    expect(c1Node.node.id).toBe(c1.id);
    expect(c1Node.children).toHaveLength(1);
    const c2Node = elementAt(thread.comments, 1);
    expect(c2Node.node.id).toBe(c2.id);
    expect(c2Node.children).toHaveLength(0);
    expect(elementAt(c1Node.children, 0).node.id).toBe(r1.id);
  });
});

/** Helper that asserts 201 and returns the reply body. */
async function createReplyViaApiSuccess(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  parentId: string,
  content: string,
): Promise<CommentBody> {
  const res = await replyResponse(appInstance, actorId, workspaceId, parentId, content);
  expect(res.status).toBe(201);
  return res.body as CommentBody;
}

// ---------------------------------------------------------------------------
// invalid / missing parent rejection
// ---------------------------------------------------------------------------

describe('C3 invalid / missing parent rejection', () => {
  it('rejects a reply to a non-existent parent with 404', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const res = await replyResponse(a, humanA.id, wsA.id, 'no-such-comment', 'hi');
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('not_found');
  });

  it('rejects a first-level comment on a non-existent post with 404', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    const a = app();
    const res = await a.request('/posts/no-such-post/comments', {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('rejects empty content with 400 on comment and reply', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'first');

    const commentRes = await a.request('/posts/p1/comments', {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: '' }),
    });
    expect(commentRes.status).toBe(400);

    const replyRes = await a.request(`/comments/${c1.id}/replies`, {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: '' }),
    });
    expect(replyRes.status).toBe(400);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const res = await a.request('/posts/p1/comments', {
      method: 'POST',
      headers: headersFor(humanA.id, wsA.id),
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// feed bump side effect on every nested reply
// ---------------------------------------------------------------------------

describe('C3 feed bump side effect', () => {
  it('every nested reply bumps the root post lastActivityAt via the shared bump helper', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    const before = domain.getPost('p1');
    expect(before && !('isDeleted' in before) ? before?.lastActivityAt : undefined).toBe(
      '2024-01-01T00:00:00.000Z',
    );

    // Use fixed createdAt timestamps so the bump is observable and monotonic.
    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'c1');
    const afterC1 = domain.getPost('p1');
    expect(afterC1 && !('isDeleted' in afterC1) ? afterC1?.lastActivityAt : undefined).toBe(
      c1.createdAt,
    );

    // Each deeper reply must advance lastActivityAt to its own createdAt.
    const r1 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, c1.id, 'r1');
    const afterR1 = domain.getPost('p1');
    expect(afterR1 && !('isDeleted' in afterR1) ? afterR1?.lastActivityAt : undefined).toBe(
      r1.createdAt,
    );

    const r2 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r1.id, 'r2');
    const afterR2 = domain.getPost('p1');
    expect(afterR2 && !('isDeleted' in afterR2) ? afterR2?.lastActivityAt : undefined).toBe(
      r2.createdAt,
    );

    const r3 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r2.id, 'r3');
    const afterR3 = domain.getPost('p1');
    expect(afterR3 && !('isDeleted' in afterR3) ? afterR3?.lastActivityAt : undefined).toBe(
      r3.createdAt,
    );

    // The bumped post now sorts first in the C2 feed (lastActivityAt DESC).
    const feed = await a.request('/posts', { headers: headersFor(humanA.id, wsA.id) });
    const feedBody = (await feed.json()) as { posts: { id: string }[] };
    expect(elementAt(feedBody.posts, 0).id).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// replyToActorId preservation
// ---------------------------------------------------------------------------

describe('C3 replyToActorId targeting', () => {
  it('preserves replyToActorId as the parent author and null for first-level comments', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    // Second author in the same workspace to make targeting observable.
    const humanA2 = domain.createActor({
      id: 'humanA2',
      workspaceId: wsA.id,
      kind: 'human',
      displayName: 'Ava',
    });
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    // First-level comment by humanA: replyToActorId is null.
    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'c1');
    expect(c1.replyToActorId).toBeNull();

    // Reply by humanA2 to c1: replyToActorId is humanA (the parent author).
    const r1 = await createReplyViaApiSuccess(a, humanA2.id, wsA.id, c1.id, 'r1');
    expect(r1.replyToActorId).toBe(humanA.id);
    expect(r1.parentId).toBe(c1.id);

    // Reply by humanA to r1: replyToActorId is humanA2 (r1's author).
    const r2 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r1.id, 'r2');
    expect(r2.replyToActorId).toBe(humanA2.id);

    // Queryable via the subtree: each node carries its replyToActorId.
    const { body } = await getSubtreeViaApi(a, humanA.id, wsA.id, c1.id);
    const tree = body as {
      root: {
        node: { replyToActorId: string | null };
        children: { node: { replyToActorId: string | null }; children: { node: { replyToActorId: string | null } }[] }[];
      };
    };
    expect(tree.root.node.replyToActorId).toBeNull();
    const r1Child = elementAt(tree.root.children, 0);
    expect(r1Child.node.replyToActorId).toBe(humanA.id);
    expect(elementAt(r1Child.children, 0).node.replyToActorId).toBe(humanA2.id);
  });

  it('preserves replyToActorId when fetching a subtree rooted at a nested reply', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    const humanA2 = domain.createActor({
      id: 'humanA2',
      workspaceId: wsA.id,
      kind: 'human',
      displayName: 'Ava',
    });
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'c1');
    const r1 = await createReplyViaApiSuccess(a, humanA2.id, wsA.id, c1.id, 'r1');
    const r2 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r1.id, 'r2');

    const { status, body } = await getSubtreeViaApi(a, humanA.id, wsA.id, r2.id);
    expect(status).toBe(200);
    const tree = body as { root: { node: { id: string; replyToActorId: string | null } } };
    expect(tree.root.node.id).toBe(r2.id);
    expect(tree.root.node.replyToActorId).toBe(humanA2.id);
  });
});

// ---------------------------------------------------------------------------
// deleted-parent behavior
// ---------------------------------------------------------------------------

describe('C3 deleted-parent behavior', () => {
  it('rejects a reply to a soft-deleted parent with 409 and preserves children as tombstones', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    // Build c1 -> r1 -> r2, then soft-delete r1 (the middle of the subtree).
    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'c1');
    const r1 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, c1.id, 'r1');
    const r2 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r1.id, 'r2');

    domain.softDeleteComment(r1.id, new Date().toISOString());

    // Replying to the deleted r1 is rejected at the API layer.
    const res = await replyResponse(a, humanA.id, wsA.id, r1.id, 'late reply');
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('deleted_parent');

    // The subtree rooted at c1 still returns r1 as a tombstone with r2 as a
    // preserved child (redacted author/content, structure intact).
    const { status, body } = await getSubtreeViaApi(a, humanA.id, wsA.id, c1.id);
    expect(status).toBe(200);
    const tree = body as {
      root: {
        node: { id: string; isDeleted?: true };
        children: {
          node: { id: string; isDeleted?: true; deletedAt?: string; replyToActorId: string | null };
          children: { node: { id: string; isDeleted?: true; content: string } }[];
        }[];
      };
    };
    expect(tree.root.node.id).toBe(c1.id);
    expect(tree.root.node.isDeleted).toBeUndefined();
    const r1Node = elementAt(tree.root.children, 0);
    expect(r1Node.node.id).toBe(r1.id);
    expect(r1Node.node.isDeleted).toBe(true);
    expect(r1Node.node.deletedAt).toBeTruthy();
    // Tombstone redacts reply-target context.
    expect(r1Node.node.replyToActorId).toBeNull();
    // r2 is preserved as a live child under the tombstoned r1.
    expect(r1Node.children).toHaveLength(1);
    const r2Node = elementAt(r1Node.children, 0);
    expect(r2Node.node.id).toBe(r2.id);
    expect(r2Node.node.isDeleted).toBeUndefined();
    expect(r2Node.node.content).toBe('r2');
  });

  it('rejects a reply to a live descendant under a soft-deleted ancestor with 409', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'c1');
    const r1 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, c1.id, 'r1');
    const r2 = await createReplyViaApiSuccess(a, humanA.id, wsA.id, r1.id, 'r2');

    domain.softDeleteComment(r1.id, new Date().toISOString());

    const res = await replyResponse(a, humanA.id, wsA.id, r2.id, 'blocked descendant reply');
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('deleted_parent');
  });

  it('rejects a first-level comment on a soft-deleted post with 404', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    domain.softDeletePost('p1', new Date().toISOString());
    const a = app();
    const res = await a.request('/posts/p1/comments', {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: 'late comment' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// stable sibling ordering
// ---------------------------------------------------------------------------

describe('C3 stable sibling ordering', () => {
  it('orders siblings under the same parent by createdAt ASC, id ASC', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    // Seed three replies under c1 with controlled createdAt via the repository
    // so we can assert the exact order independent of wall-clock jitter.
    const c1 = await createCommentViaApi(a, humanA.id, wsA.id, 'p1', 'c1');
    domain.createReply({
      id: 'late',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      parentId: c1.id,
      authorActorId: humanA.id,
      content: 'late',
      createdAt: '2024-02-01T00:00:00.000Z',
    });
    domain.createReply({
      id: 'early',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      parentId: c1.id,
      authorActorId: humanA.id,
      content: 'early',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    // Same createdAt as 'early' to exercise the id ASC tiebreaker.
    domain.createReply({
      id: 'aaa',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      parentId: c1.id,
      authorActorId: humanA.id,
      content: 'aaa',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    const { body } = await getSubtreeViaApi(a, humanA.id, wsA.id, c1.id);
    const tree = body as { root: { children: { node: { id: string } }[] } };
    const order = tree.root.children.map((c) => c.node.id);
    // createdAt ASC: 'early' and 'aaa' (2024-01-01) before 'late' (2024-02-01).
    // id ASC tiebreaker: 'aaa' before 'early'.
    expect(order).toEqual(['aaa', 'early', 'late']);
  });

  it('orders first-level comments in the full thread by createdAt ASC, id ASC', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();

    domain.createComment({
      id: 'zeta',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'zeta',
      createdAt: '2024-03-01T00:00:00.000Z',
    });
    domain.createComment({
      id: 'alpha',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'alpha',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    domain.createComment({
      id: 'beta',
      workspaceId: wsA.id,
      rootPostId: 'p1',
      authorActorId: humanA.id,
      content: 'beta',
      createdAt: '2024-02-01T00:00:00.000Z',
    });

    const { body } = await getThreadViaApi(a, humanA.id, wsA.id, 'p1');
    const thread = body as { comments: { node: { id: string } }[] };
    expect(thread.comments.map((c) => c.node.id)).toEqual(['alpha', 'beta', 'zeta']);
  });
});

// ---------------------------------------------------------------------------
// workspace/group boundary
// ---------------------------------------------------------------------------

describe('C3 workspace/group boundary', () => {
  it('rejects a comment on another workspace post with 403', async () => {
    const { wsA, wsB, humanA, humanB } = twoWorkspaceFixture();
    seedPost('pB', wsB.id, humanB.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const res = await a.request('/posts/pB/comments', {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: 'cross' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a reply to a comment in another workspace with 403', async () => {
    const { wsA, wsB, humanA, humanB } = twoWorkspaceFixture();
    seedPost('pB', wsB.id, humanB.id, 'post', '2024-01-01T00:00:00.000Z');
    const cB = domain.createComment({
      id: 'cB',
      workspaceId: wsB.id,
      rootPostId: 'pB',
      authorActorId: humanB.id,
      content: 'cB',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    const a = app();
    const res = await a.request(`/comments/${cB.id}/replies`, {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: 'cross' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a subtree read on a comment in another workspace with 403', async () => {
    const { wsA, wsB, humanA, humanB } = twoWorkspaceFixture();
    seedPost('pB', wsB.id, humanB.id, 'post', '2024-01-01T00:00:00.000Z');
    const cB = domain.createComment({
      id: 'cB',
      workspaceId: wsB.id,
      rootPostId: 'pB',
      authorActorId: humanB.id,
      content: 'cB',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    const a = app();
    const res = await a.request(`/comments/${cB.id}/subtree`, {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a full-thread read on a post in another workspace with 403', async () => {
    const { wsA, wsB, humanA, humanB } = twoWorkspaceFixture();
    seedPost('pB', wsB.id, humanB.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const res = await a.request('/posts/pB/thread', {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a read-only principal from creating a comment with 403', async () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');
    seedPost('p1', wsA.id, humanA.id, 'post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const res = await a.request('/posts/p1/comments', {
      method: 'POST',
      headers: jsonHeaders(humanA.id, wsA.id),
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(403);
  });
});
