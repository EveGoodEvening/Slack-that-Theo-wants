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
 * C5 conversation UI tests.
 *
 * The post detail UI is server-rendered HTML over C2 read-post and C3 full-thread
 * services. These tests exercise browser form surfaces against the mounted
 * Hono app so the route wiring, service consumption, feed bump, nesting, and
 * C3a sanitization paths are covered together.
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

function workspaceFixture() {
  const workspace = domain.createWorkspace({
    id: 'wsA',
    slug: 'team-a',
    name: 'Team A',
  });
  const ada = domain.createActor({
    id: 'ada',
    workspaceId: workspace.id,
    kind: 'human',
    displayName: 'Ada',
  });
  const bo = domain.createActor({
    id: 'bo',
    workspaceId: workspace.id,
    kind: 'human',
    displayName: 'Bo',
  });
  const cy = domain.createActor({
    id: 'cy',
    workspaceId: workspace.id,
    kind: 'human',
    displayName: 'Cy',
  });
  return { workspace, ada, bo, cy };
}

function seedPost(
  id: string,
  workspaceId: string,
  authorActorId: string,
  content: string,
  lastActivityAt: string,
): void {
  domain.createPost({ id, workspaceId, authorActorId, content, lastActivityAt });
}

function seedComment(input: {
  id: string;
  workspaceId: string;
  rootPostId: string;
  authorActorId: string;
  content: string;
  createdAt: string;
}): void {
  domain.createComment(input);
}

function seedReply(input: {
  id: string;
  workspaceId: string;
  rootPostId: string;
  parentId: string;
  authorActorId: string;
  content: string;
  createdAt: string;
}): void {
  domain.createReply(input);
}

async function getPostDetail(
  appInstance: Hono,
  postId: string,
  actorId: string,
  workspaceId: string,
): Promise<{ status: number; html: string }> {
  const res = await appInstance.request(`/feed/${postId}`, {
    headers: headersFor(actorId, workspaceId),
  });
  return { status: res.status, html: await res.text() };
}

async function postCommentForm(
  appInstance: Hono,
  postId: string,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ status: number; html: string }> {
  const form = new URLSearchParams();
  form.set('content', content);
  form.set('actorId', actorId);
  form.set('workspaceId', workspaceId);
  const res = await appInstance.request(`/feed/${postId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { status: res.status, html: await res.text() };
}

async function postReplyForm(
  appInstance: Hono,
  postId: string,
  parentId: string,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ status: number; html: string }> {
  const form = new URLSearchParams();
  form.set('content', content);
  form.set('actorId', actorId);
  form.set('workspaceId', workspaceId);
  const res = await appInstance.request(
    `/feed/${postId}/comments/${parentId}/replies`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
  );
  return { status: res.status, html: await res.text() };
}

describe('C5 post detail conversation rendering', () => {
  it('renders first-level comments with nested reply composers and reply-target context', async () => {
    const { workspace, ada, bo, cy } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: 'First comment',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    seedReply({
      id: 'reply-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      parentId: 'comment-a',
      authorActorId: cy.id,
      content: 'Nested reply',
      createdAt: '2026-01-01T00:02:00.000Z',
    });

    const { status, html } = await getPostDetail(app(), 'post-1', ada.id, workspace.id);

    expect(status).toBe(200);
    expect(html).toContain('Root post');
    expect(html).toContain('First comment');
    expect(html).toContain('Nested reply');
    expect(html).toContain('Replying to <span>@bo</span>');
    expect(html).toContain('/feed/post-1/comments/comment-a/replies');
    expect(html).toContain('data-parent-id="comment-a"');
  });

  it('replies to different comments and renders each reply under the correct parent', async () => {
    const { workspace, ada, bo, cy } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: 'Alpha parent',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    seedComment({
      id: 'comment-b',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: cy.id,
      content: 'Beta parent',
      createdAt: '2026-01-01T00:02:00.000Z',
    });
    const a = app();

    const alpha = await postReplyForm(
      a,
      'post-1',
      'comment-a',
      ada.id,
      workspace.id,
      'Reply under alpha',
    );
    const beta = await postReplyForm(
      a,
      'post-1',
      'comment-b',
      ada.id,
      workspace.id,
      'Reply under beta',
    );

    expect(alpha.status).toBe(201);
    expect(beta.status).toBe(201);
    expect(beta.html).toMatch(/data-parent-id="comment-a"[\s\S]*Reply under alpha/);
    expect(beta.html).toMatch(/data-parent-id="comment-b"[\s\S]*Reply under beta/);
    expect(beta.html).toMatch(/Replying to <span>@bo<\/span>[\s\S]*Reply under alpha/);
    expect(beta.html).toMatch(/Replying to <span>@cy<\/span>[\s\S]*Reply under beta/);
  });

  it('rejects a reply parent from a different route post without creating or bumping', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost('post-a', workspace.id, ada.id, 'Route post', '2026-01-01T00:00:00.000Z');
    seedPost('post-b', workspace.id, ada.id, 'Parent post', '2026-02-01T00:00:00.000Z');
    seedComment({
      id: 'comment-b',
      workspaceId: workspace.id,
      rootPostId: 'post-b',
      authorActorId: bo.id,
      content: 'Parent on another post',
      createdAt: '2026-02-01T00:01:00.000Z',
    });
    const postBBefore = domain.getPost('post-b');
    expect(postBBefore).toBeDefined();
    if (postBBefore === undefined || 'isDeleted' in postBBefore) {
      throw new Error('post-b missing before rejected reply');
    }
    const postBLastActivityBeforeRejectedReply = postBBefore.lastActivityAt;

    const response = await postReplyForm(
      app(),
      'post-a',
      'comment-b',
      ada.id,
      workspace.id,
      '<b>cross-post reply</b>',
    );
    const postBAfter = domain.getPost('post-b');

    expect(response.status).toBe(409);
    expect(response.html).toContain('reply parent does not belong to this post');
    expect(response.html).not.toContain('Reply added.');
    expect(response.html).not.toContain('&lt;b&gt;cross-post reply&lt;/b&gt;');
    expect(domain.countCommentsForPost('post-a')).toBe(0);
    expect(domain.countCommentsForPost('post-b')).toBe(1);
    expect(domain.getSubtree('comment-b')).toHaveLength(1);
    expect(postBAfter).toBeDefined();
    if (postBAfter === undefined || 'isDeleted' in postBAfter) {
      throw new Error('post-b missing after rejected reply');
    }
    expect(postBAfter.lastActivityAt).toBe(postBLastActivityBeforeRejectedReply);
  });

  it('a reply on an old post bumps that post to the top of the feed', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost('old-post', workspace.id, ada.id, 'Old post', '2026-01-01T00:00:00.000Z');
    seedPost('new-post', workspace.id, ada.id, 'Newer post', '2026-02-01T00:00:00.000Z');
    seedComment({
      id: 'old-comment',
      workspaceId: workspace.id,
      rootPostId: 'old-post',
      authorActorId: bo.id,
      content: 'Old comment',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    const a = app();

    const reply = await postReplyForm(
      a,
      'old-post',
      'old-comment',
      ada.id,
      workspace.id,
      'Bumping reply',
    );
    const feed = await a.request('/feed', {
      headers: headersFor(ada.id, workspace.id),
    });
    const html = await feed.text();

    expect(reply.status).toBe(201);
    expect(feed.status).toBe(200);
    const oldIdx = html.indexOf('Old post');
    const newIdx = html.indexOf('Newer post');
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeLessThan(newIdx);
  });

  it('sanitizes unsafe HTML/script on first-level, reply, and nested reply surfaces', async () => {
    const { workspace, ada, bo, cy } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: '<script>alert("comment")</script>',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    seedReply({
      id: 'reply-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      parentId: 'comment-a',
      authorActorId: cy.id,
      content: '[bad](javascript:alert(1))',
      createdAt: '2026-01-01T00:02:00.000Z',
    });
    seedReply({
      id: 'reply-b',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      parentId: 'reply-a',
      authorActorId: ada.id,
      content: '<img src=x onerror=alert(1)>',
      createdAt: '2026-01-01T00:03:00.000Z',
    });

    const { status, html } = await getPostDetail(app(), 'post-1', ada.id, workspace.id);

    expect(status).toBe(200);
    expect(html).not.toContain('<script>alert("comment")</script>');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/<\s*img\b/i);
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).toContain('bad');
  });

  it('uses a depth safeguard for very deep reply trees', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-0',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: 'Depth zero',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    let parentId = 'comment-0';
    for (let depth = 1; depth <= 150; depth += 1) {
      const id = `reply-${depth}`;
      seedReply({
        id,
        workspaceId: workspace.id,
        rootPostId: 'post-1',
        parentId,
        authorActorId: ada.id,
        content: `Depth ${depth}`,
        createdAt: `2026-01-01T00:00:00.${String(depth).padStart(3, '0')}Z`,
      });
      parentId = id;
    }

    const { html } = await getPostDetail(app(), 'post-1', ada.id, workspace.id);

    expect(html).toContain('reply-depth-safeguard');
    expect(html).toContain('100+ deeper replies are collapsed');
    expect(html).not.toContain('0 deeper replies are collapsed');
    expect(html).toMatch(
      /<details class="reply-branch" open>[\s\S]*<ol class="reply-list">[\s\S]*<\/ol>[\s\S]*<\/details>/,
    );
  });

  it('does not show the depth safeguard when a max-depth leaf has no hidden children', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-0',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: 'Depth zero',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    let parentId = 'comment-0';
    for (let depth = 1; depth <= 8; depth += 1) {
      const id = `reply-${depth}`;
      seedReply({
        id,
        workspaceId: workspace.id,
        rootPostId: 'post-1',
        parentId,
        authorActorId: ada.id,
        content: `Depth ${depth}`,
        createdAt: `2026-01-01T00:00:00.${String(depth).padStart(3, '0')}Z`,
      });
      parentId = id;
    }

    const { html } = await getPostDetail(app(), 'post-1', ada.id, workspace.id);

    expect(html).toContain('Depth 8');
    expect(html).not.toContain('<p class="reply-depth-safeguard">');
    expect(html).not.toContain('0 deeper replies are collapsed');
  });

  it('creates a first-level comment through the post detail composer', async () => {
    const { workspace, ada } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');

    const { status, html } = await postCommentForm(
      app(),
      'post-1',
      ada.id,
      workspace.id,
      'Composer comment',
    );

    expect(status).toBe(201);
    expect(html).toContain('Comment added.');
    expect(html).toContain('Composer comment');
    expect(html).toContain('1 total comment/reply; 1 first-level comment.');
  });
});
