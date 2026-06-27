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
import { ACTIVITY_EVENT_TYPES } from '../api/activityEvents.js';

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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''));
}

function firstCodeBlockText(html: string): string {
  const match = /<pre><code(?: class="[^"]+")?>([\s\S]*?)<\/code><\/pre>/.exec(html);
  expect(match).not.toBeNull();
  return stripTags(match?.[1] ?? '');
}

function firstCodeBlockHtml(html: string): string {
  const match = /<pre><code(?: class="[^"]+")?>([\s\S]*?)<\/code><\/pre>/.exec(html);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
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

describe('C6 code blocks in the conversation UI', () => {
  it('renders a fenced code block in a nested reply with formatting and copy affordance', async () => {
    const { workspace, ada, bo, cy } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: 'Look at this code:',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    const code = '```ts\nconst sum = (a, b) => {\n  return a + b;\n};\n```';
    seedReply({
      id: 'reply-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      parentId: 'comment-a',
      authorActorId: cy.id,
      content: code,
      createdAt: '2026-01-01T00:02:00.000Z',
    });

    const { status, html } = await getPostDetail(app(), 'post-1', ada.id, workspace.id);

    expect(status).toBe(200);
    // The code block is rendered (not escaped as a whole) inside the reply.
    expect(html).toMatch(/<figure class="code-block" data-lang="ts">/);
    expect(html).toMatch(/<pre><code class="language-ts">/);
    const renderedCode = firstCodeBlockText(html);
    expect(renderedCode).toBe('const sum = (a, b) => {\n  return a + b;\n};');
    // Highlighting + copy affordance are present.
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('class="copy-code"');
    // The reply surface still blocks live event-handler injection.
    expect(html).not.toMatch(/<[^>]+\son\w+\s*=/i);
  });

  it('sanitizes a script payload inside a code block on the nested reply surface', async () => {
    const { workspace, ada, bo, cy } = workspaceFixture();
    seedPost('post-1', workspace.id, ada.id, 'Root post', '2026-01-01T00:00:00.000Z');
    seedComment({
      id: 'comment-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      authorActorId: bo.id,
      content: 'check this',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    seedReply({
      id: 'reply-a',
      workspaceId: workspace.id,
      rootPostId: 'post-1',
      parentId: 'comment-a',
      authorActorId: cy.id,
      content: '```\n<script>alert(1)</script>\n```',
      createdAt: '2026-01-01T00:02:00.000Z',
    });

    const { html } = await getPostDetail(app(), 'post-1', ada.id, workspace.id);

    const codeHtml = firstCodeBlockHtml(html);
    expect(codeHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(codeHtml).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/<[^>]+\son\w+\s*=/i);
    expect(html).toContain('class="copy-code"');
  });

  it('renders a code block in a post body on the feed with a copy button', async () => {
    const { workspace, ada } = workspaceFixture();
    seedPost('post-code', workspace.id, ada.id, '```js\nconsole.log("hi");\n```', '2026-01-01T00:00:00.000Z');

    const res = await app().request('/feed', { headers: headersFor(ada.id, workspace.id) });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/<figure class="code-block" data-lang="js">/);
    expect(html).toContain('<span class="tok-string">&quot;hi&quot;</span>');
    expect(html).toContain('class="copy-code"');
  });

  it('renders a sanitized preview of code-block content via POST /feed/preview', async () => {
    const { workspace, ada } = workspaceFixture();
    const a = app();
    const form = new URLSearchParams();
    form.set('content', '```ts\nconst x = 1;\n```');
    const res = await a.request('/feed/preview', {
      method: 'POST',
      headers: { ...headersFor(ada.id, workspace.id), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/<figure class="code-block" data-lang="ts">/);
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(firstCodeBlockText(html)).toBe('const x = 1;');
    expect(html).not.toMatch(/<[^>]+\son\w+\s*=/i);
  });

  it('rejects a preview request without a valid principal', async () => {
    const form = new URLSearchParams();
    form.set('content', 'hello');
    const res = await app().request('/feed/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(401);
  });
});

type PostDetailRealtimeMessage = { data: string };
type PostDetailRealtimeListener = (message: PostDetailRealtimeMessage) => void;
type PostDetailFetchResponse = { ok: boolean; text(): Promise<string> };

class PostDetailRealtimeEventSource {
  static instances: PostDetailRealtimeEventSource[] = [];
  readonly listeners = new Map<string, PostDetailRealtimeListener[]>();

  constructor(readonly url: string) {
    PostDetailRealtimeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: PostDetailRealtimeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }
}

class PostDetailRealtimeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: PostDetailRealtimeElement[] = [];
  parent: PostDetailRealtimeElement | null = null;
  textContent = '';
  private html = '';

  constructor(tagName: string, attrs: Record<string, string> = {}, html = '') {
    this.tagName = tagName.toLowerCase();
    this.html = html;
    for (const [name, value] of Object.entries(attrs)) {
      this.attributes.set(name, value);
    }
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
  }

  appendChild(child: PostDetailRealtimeElement): void {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
  }

  removeChild(child: PostDetailRealtimeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
  }

  replaceWith(next: PostDetailRealtimeElement): void {
    const parent = this.parent;
    if (!parent) return;
    if (next.parent) next.parent.removeChild(next);
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    next.parent = parent;
    parent.children[index] = next;
    this.parent = null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): PostDetailRealtimeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  matches(selector: string): boolean {
    if (selector === '.conversation') return this.hasClass('conversation');
    if (selector === '[data-realtime-status]') {
      return this.getAttribute('data-realtime-status') !== null;
    }
    return false;
  }

  private hasClass(className: string): boolean {
    return (this.getAttribute('class') ?? '').split(/\s+/).includes(className);
  }
}

class PostDetailRealtimeTemplateElement extends PostDetailRealtimeElement {
  readonly content: { firstElementChild: PostDetailRealtimeElement | null } = {
    firstElementChild: null,
  };

  constructor() {
    super('template');
  }

  override get innerHTML(): string {
    return super.innerHTML;
  }

  override set innerHTML(value: string) {
    super.innerHTML = value;
    this.content.firstElementChild = /class="[^"]*conversation[^"]*"/.test(value)
      ? new PostDetailRealtimeElement('section', { class: 'conversation' }, value)
      : null;
  }
}

class PostDetailRealtimeDocument {
  readonly root = new PostDetailRealtimeElement('main');
  readonly status = new PostDetailRealtimeElement('p', { 'data-realtime-status': 'idle' });

  constructor() {
    this.root.appendChild(
      new PostDetailRealtimeElement(
        'section',
        { class: 'conversation' },
        '<section class="conversation">stale conversation</section>',
      ),
    );
  }

  querySelector(selector: string): PostDetailRealtimeElement | null {
    if (selector === '[data-realtime-status]') return this.status;
    return this.root.querySelector(selector);
  }

  createElement(tagName: string): PostDetailRealtimeElement {
    if (tagName.toLowerCase() === 'template') {
      return new PostDetailRealtimeTemplateElement();
    }
    return new PostDetailRealtimeElement(tagName);
  }

  conversation(): PostDetailRealtimeElement {
    const conversation = this.root.querySelector('.conversation');
    expect(conversation).not.toBeNull();
    if (conversation === null) throw new Error('expected conversation element');
    return conversation;
  }
}

function extractPostDetailRealtimeScript(html: string): string {
  const marker = '// C8 progressive enhancement: refresh this conversation on scoped activity.';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  if (start < 0) throw new Error('expected post-detail realtime script marker');
  const script = html.slice(start);
  const endMarker = '\n    })();';
  const end = script.indexOf(endMarker);
  expect(end).toBeGreaterThanOrEqual(0);
  if (end < 0) throw new Error('expected post-detail realtime script end');
  return script.slice(0, end + endMarker.length);
}

function installPostDetailRealtimeGlobals(
  document: PostDetailRealtimeDocument,
  fetchResponse: (url: string) => Promise<PostDetailFetchResponse>,
): string[] {
  const fetches: string[] = [];
  PostDetailRealtimeEventSource.instances = [];
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'EventSource', {
    value: PostDetailRealtimeEventSource,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: (url: string, _init: unknown) => {
      fetches.push(url);
      return fetchResponse(url);
    },
    configurable: true,
  });
  return fetches;
}

function currentPostDetailEventSource(): PostDetailRealtimeEventSource {
  const source = PostDetailRealtimeEventSource.instances[0];
  expect(source).toBeDefined();
  if (source === undefined) throw new Error('expected post-detail EventSource');
  return source;
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value: T) => resolvePromise(value);
    reject = (reason?: unknown) => rejectPromise(reason);
  });
  return { promise, resolve, reject };
}

describe('C8 post detail realtime progressive enhancement', () => {
  it('executes comment/reply handlers only for the matching root post', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost(
      'post1',
      workspace.id,
      ada.id,
      'Realtime post',
      '2024-01-01T00:00:00.000Z',
    );
    seedPost(
      'post2',
      workspace.id,
      ada.id,
      'Other realtime post',
      '2024-01-01T00:00:00.000Z',
    );
    const a = app();

    const detail = await getPostDetail(a, 'post1', ada.id, workspace.id);
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('/events?actorId=ada&workspaceId=wsA');
    expect(detail.html).toContain(ACTIVITY_EVENT_TYPES.commentCreated);
    expect(detail.html).toContain(ACTIVITY_EVENT_TYPES.replyCreated);

    const script = extractPostDetailRealtimeScript(detail.html);
    const document = new PostDetailRealtimeDocument();
    const fetches = installPostDetailRealtimeGlobals(document, async (url) => {
      const res = await a.request(url);
      return { ok: res.status === 200, text: () => res.text() };
    });

    Function(script)();
    const source = currentPostDetailEventSource();
    expect(source.url).toBe('/events?actorId=ada&workspaceId=wsA');
    expect(source.listeners.has(ACTIVITY_EVENT_TYPES.commentCreated)).toBe(true);
    expect(source.listeners.has(ACTIVITY_EVENT_TYPES.replyCreated)).toBe(true);
    expect(source.listeners.has(ACTIVITY_EVENT_TYPES.postCreated)).toBe(false);
    const initialConversation = document.conversation();

    source.emit(ACTIVITY_EVENT_TYPES.postCreated, { rootPostId: 'post1' });
    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, { rootPostId: 'post2' });
    await flushPromises();
    expect(fetches).toEqual([]);
    expect(document.conversation()).toBe(initialConversation);

    seedComment({
      id: 'comment-live',
      workspaceId: workspace.id,
      rootPostId: 'post1',
      authorActorId: ada.id,
      content: 'background detail update',
      createdAt: '2024-01-02T00:00:00.000Z',
    });
    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, { rootPostId: 'post1' });
    await flushPromises();

    const fragmentUrl = '/feed/post1/fragments/conversation?actorId=ada&workspaceId=wsA';
    expect(fetches).toEqual([fragmentUrl]);
    const afterComment = document.conversation();
    expect(afterComment).not.toBe(initialConversation);
    expect(afterComment.innerHTML).toContain('background detail update');

    seedReply({
      id: 'reply-live',
      workspaceId: workspace.id,
      rootPostId: 'post1',
      parentId: 'comment-live',
      authorActorId: bo.id,
      content: 'nested realtime reply',
      createdAt: '2024-01-03T00:00:00.000Z',
    });
    source.emit(ACTIVITY_EVENT_TYPES.replyCreated, { rootPostId: 'post1' });
    await flushPromises();

    expect(fetches).toEqual([fragmentUrl, fragmentUrl]);
    const afterReply = document.conversation();
    expect(afterReply).not.toBe(afterComment);
    expect(afterReply.innerHTML).toContain('nested realtime reply');
  });

  it('ignores a stale conversation fragment when matching post-detail fetches resolve out of order', async () => {
    const { workspace, ada } = workspaceFixture();
    seedPost(
      'post1',
      workspace.id,
      ada.id,
      'Realtime stale-race post',
      '2024-01-01T00:00:00.000Z',
    );
    const a = app();
    const detail = await getPostDetail(a, 'post1', ada.id, workspace.id);
    expect(detail.status).toBe(200);

    const script = extractPostDetailRealtimeScript(detail.html);
    const document = new PostDetailRealtimeDocument();
    const olderFetch = deferred<PostDetailFetchResponse>();
    const newerFetch = deferred<PostDetailFetchResponse>();
    const pendingFetches = [olderFetch, newerFetch];
    const fetches = installPostDetailRealtimeGlobals(document, () => {
      const next = pendingFetches.shift();
      expect(next).toBeDefined();
      if (next === undefined) throw new Error('unexpected post-detail fragment fetch');
      return next.promise;
    });

    Function(script)();
    const source = currentPostDetailEventSource();
    const fragmentUrl = '/feed/post1/fragments/conversation?actorId=ada&workspaceId=wsA';
    const olderActivityAt = '2024-01-02T00:00:00.000Z';
    const newerActivityAt = '2024-01-03T00:00:00.000Z';

    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, {
      rootPostId: 'post1',
      rootPostLastActivityAt: olderActivityAt,
    });
    source.emit(ACTIVITY_EVENT_TYPES.replyCreated, {
      rootPostId: 'post1',
      rootPostLastActivityAt: newerActivityAt,
    });

    expect(fetches).toEqual([fragmentUrl, fragmentUrl]);

    newerFetch.resolve({
      ok: true,
      text: async () => '<section class="conversation">newer conversation with latest reply</section>',
    });
    await flushPromises();
    const afterNewer = document.conversation();
    expect(afterNewer.innerHTML).toContain('newer conversation with latest reply');

    olderFetch.resolve({
      ok: true,
      text: async () => '<section class="conversation">stale older conversation</section>',
    });
    await flushPromises();

    expect(document.conversation()).toBe(afterNewer);
    expect(document.conversation().innerHTML).toContain('newer conversation with latest reply');
    expect(document.conversation().innerHTML).not.toContain('stale older conversation');
  });
});
