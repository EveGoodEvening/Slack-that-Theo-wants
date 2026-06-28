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
import { AuthRepository, sessionCookie } from '../security/auth.js';
import { createApp, type AppDeps } from '../index.js';
import { ACTIVITY_EVENT_TYPES } from '../api/activityEvents.js';
import { PREVIEW_SCRIPT } from './codeBlockUi.js';

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
let auth: AuthRepository;

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
  auth = new AuthRepository(db);
});

function app(): Hono {
  const deps: AppDeps = { repository: domain, membership, auth };
  return createApp(deps);
}

function headersFor(actorId: string, workspaceId: string): Record<string, string> {
  const session = auth.createSession({ actorId, workspaceId });
  return { cookie: sessionCookie(session.secret) };
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
  const res = await appInstance.request(`/feed/${postId}/comments`, {
    method: 'POST',
    headers: { ...headersFor(actorId, workspaceId), 'content-type': 'application/x-www-form-urlencoded' },
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
  const res = await appInstance.request(
    `/feed/${postId}/comments/${parentId}/replies`,
    {
      method: 'POST',
      headers: { ...headersFor(actorId, workspaceId), 'content-type': 'application/x-www-form-urlencoded' },
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
type PostDetailRealtimeDomListener = (event: { target: PostDetailRealtimeElement }) => void;
type PostDetailFetchResponse = { ok: boolean; text(): Promise<string> };
type PostDetailFetchInit = { method?: string; headers?: Record<string, string>; body?: string };

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
  ownerDocument: PostDetailRealtimeDocument | null = null;
  textContent = '';
  value = '';
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection: 'forward' | 'backward' | 'none' = 'none';
  private html = '';
  private readonly domListeners = new Map<string, Array<() => void>>();

  constructor(
    tagName: string,
    attrs: Record<string, string> = {},
    html = '',
    ownerDocument: PostDetailRealtimeDocument | null = null,
  ) {
    this.tagName = tagName.toLowerCase();
    this.html = html;
    this.ownerDocument = ownerDocument;
    for (const [name, value] of Object.entries(attrs)) {
      this.attributes.set(name, value);
    }
    if (this.tagName === 'textarea') this.value = decodeHtmlEntities(html);
    if (this.tagName === 'input') this.value = this.getAttribute('value') ?? '';
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
    child.setOwnerDocument(this.ownerDocument);
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
    next.setOwnerDocument(parent.ownerDocument);
    parent.children[index] = next;
    this.parent = null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): PostDetailRealtimeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): PostDetailRealtimeElement[] {
    const matches: PostDetailRealtimeElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  closest(selector: string): PostDetailRealtimeElement | null {
    let current: PostDetailRealtimeElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parent;
    }
    return null;
  }

  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);

    const classAttrMatch = /^\.([A-Za-z0-9_-]+)\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (classAttrMatch) {
      const className = classAttrMatch[1];
      const attrName = classAttrMatch[2];
      if (className === undefined || attrName === undefined) return false;
      const attrValue = classAttrMatch[3];
      if (!this.hasClass(className)) return false;
      const actual = this.getAttribute(attrName);
      return attrValue === undefined ? actual !== null : actual === attrValue;
    }

    if (selector.startsWith('.')) return this.hasClass(selector.slice(1));
    if (selector === this.tagName) return true;

    const attrMatch = /^([A-Za-z0-9_-]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attrMatch) {
      const tagName = attrMatch[1];
      const attrName = attrMatch[2];
      if (attrName === undefined) return false;
      const attrValue = attrMatch[3];
      if (tagName && tagName.toLowerCase() !== this.tagName) return false;
      const actual = this.getAttribute(attrName);
      return attrValue === undefined ? actual !== null : actual === attrValue;
    }

    return false;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.domListeners.get(type) ?? [];
    listeners.push(listener);
    this.domListeners.set(type, listeners);
  }

  click(): void {
    for (const listener of this.domListeners.get('click') ?? []) listener();
    if (this.ownerDocument) this.ownerDocument.dispatchClick(this);
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  setSelectionRange(
    selectionStart: number,
    selectionEnd: number,
    selectionDirection: 'forward' | 'backward' | 'none' = 'none',
  ): void {
    this.selectionStart = selectionStart;
    this.selectionEnd = selectionEnd;
    this.selectionDirection = selectionDirection;
  }

  private hasClass(className: string): boolean {
    return (this.getAttribute('class') ?? '').split(/\s+/).includes(className);
  }

  private setOwnerDocument(ownerDocument: PostDetailRealtimeDocument | null): void {
    this.ownerDocument = ownerDocument;
    for (const child of this.children) child.setOwnerDocument(ownerDocument);
  }
}

function parsePostDetailRealtimeAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g;
  for (let match = attrPattern.exec(source); match !== null; match = attrPattern.exec(source)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      attrs[name] = decodeHtmlEntities(value);
    }
  }
  return attrs;
}

function parsePostDetailRealtimeConversation(
  html: string,
  ownerDocument: PostDetailRealtimeDocument | null,
): PostDetailRealtimeElement | null {
  if (!/class="[^"]*conversation[^"]*"/.test(html)) return null;
  const section = new PostDetailRealtimeElement(
    'section',
    { class: 'conversation' },
    html,
    ownerDocument,
  );
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/g;
  for (let formMatch = formPattern.exec(html); formMatch !== null; formMatch = formPattern.exec(html)) {
    const formAttrs = formMatch[1] ?? '';
    const formHtml = formMatch[2] ?? '';
    const form = new PostDetailRealtimeElement(
      'form',
      parsePostDetailRealtimeAttributes(formAttrs),
      formMatch[0] ?? '',
      ownerDocument,
    );

    const textareaPattern = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
    for (let textareaMatch = textareaPattern.exec(formHtml); textareaMatch !== null; textareaMatch = textareaPattern.exec(formHtml)) {
      const textareaAttrs = textareaMatch[1] ?? '';
      const textareaHtml = textareaMatch[2] ?? '';
      const textarea = new PostDetailRealtimeElement(
        'textarea',
        parsePostDetailRealtimeAttributes(textareaAttrs),
        textareaHtml,
        ownerDocument,
      );
      form.appendChild(textarea);
    }

    const inputPattern = /<input\b([^>]*)\/?>(?:<\/input>)?/g;
    for (let inputMatch = inputPattern.exec(formHtml); inputMatch !== null; inputMatch = inputPattern.exec(formHtml)) {
      const inputAttrs = inputMatch[1] ?? '';
      const input = new PostDetailRealtimeElement(
        'input',
        parsePostDetailRealtimeAttributes(inputAttrs),
        '',
        ownerDocument,
      );
      form.appendChild(input);
    }

    const buttonPattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    for (let buttonMatch = buttonPattern.exec(formHtml); buttonMatch !== null; buttonMatch = buttonPattern.exec(formHtml)) {
      const buttonAttrs = buttonMatch[1] ?? '';
      const buttonHtml = buttonMatch[2] ?? '';
      const button = new PostDetailRealtimeElement(
        'button',
        parsePostDetailRealtimeAttributes(buttonAttrs),
        buttonHtml,
        ownerDocument,
      );
      button.textContent = stripTags(buttonHtml);
      form.appendChild(button);
    }

    const divPattern = /<div\b([^>]*)>([\s\S]*?)<\/div>/g;
    for (let divMatch = divPattern.exec(formHtml); divMatch !== null; divMatch = divPattern.exec(formHtml)) {
      const divAttrs = divMatch[1] ?? '';
      const divHtml = divMatch[2] ?? '';
      const div = new PostDetailRealtimeElement(
        'div',
        parsePostDetailRealtimeAttributes(divAttrs),
        divHtml,
        ownerDocument,
      );
      div.textContent = stripTags(divHtml);
      form.appendChild(div);
    }

    section.appendChild(form);
  }
  return section;
}

class PostDetailRealtimeTemplateElement extends PostDetailRealtimeElement {
  readonly content: { firstElementChild: PostDetailRealtimeElement | null } = {
    firstElementChild: null,
  };

  constructor(ownerDocument: PostDetailRealtimeDocument | null) {
    super('template', {}, '', ownerDocument);
  }

  override get innerHTML(): string {
    return super.innerHTML;
  }

  override set innerHTML(value: string) {
    super.innerHTML = value;
    this.content.firstElementChild = parsePostDetailRealtimeConversation(
      value,
      this.ownerDocument,
    );
  }
}

class PostDetailRealtimeDocument {
  readonly root: PostDetailRealtimeElement;
  readonly status: PostDetailRealtimeElement;
  activeElement: PostDetailRealtimeElement | null = null;
  private readonly domListeners = new Map<string, PostDetailRealtimeDomListener[]>();

  constructor() {
    this.root = new PostDetailRealtimeElement('main', {}, '', this);
    this.status = new PostDetailRealtimeElement(
      'p',
      { 'data-realtime-status': 'idle' },
      '',
      this,
    );
    this.root.appendChild(
      new PostDetailRealtimeElement(
        'section',
        { class: 'conversation' },
        '<section class="conversation">stale conversation</section>',
        this,
      ),
    );
  }

  addEventListener(type: string, listener: PostDetailRealtimeDomListener): void {
    const listeners = this.domListeners.get(type) ?? [];
    listeners.push(listener);
    this.domListeners.set(type, listeners);
  }

  dispatchClick(target: PostDetailRealtimeElement): void {
    for (const listener of this.domListeners.get('click') ?? []) {
      listener({ target });
    }
  }

  querySelector(selector: string): PostDetailRealtimeElement | null {
    if (this.status.matches(selector)) return this.status;
    if (this.root.matches(selector)) return this.root;
    return this.root.querySelector(selector);
  }

  querySelectorAll(selector: string): PostDetailRealtimeElement[] {
    const matches = this.root.matches(selector) ? [this.root] : [];
    matches.push(...this.root.querySelectorAll(selector));
    if (this.status.matches(selector)) matches.push(this.status);
    return matches;
  }

  getElementById(id: string): PostDetailRealtimeElement | null {
    const visit = (element: PostDetailRealtimeElement): PostDetailRealtimeElement | null => {
      if (element.getAttribute('id') === id) return element;
      for (const child of element.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this.root);
  }

  createElement(tagName: string): PostDetailRealtimeElement {
    if (tagName.toLowerCase() === 'template') {
      return new PostDetailRealtimeTemplateElement(this);
    }
    return new PostDetailRealtimeElement(tagName, {}, '', this);
  }

  conversation(): PostDetailRealtimeElement {
    const conversation = this.root.querySelector('.conversation');
    expect(conversation).not.toBeNull();
    if (conversation === null) throw new Error('expected conversation element');
    return conversation;
  }
}

function appendPostDetailRealtimeComposer(
  document: PostDetailRealtimeDocument,
  formClass: 'comment-composer' | 'reply-composer',
  textareaId: string,
): {
  form: PostDetailRealtimeElement;
  textarea: PostDetailRealtimeElement;
  button: PostDetailRealtimeElement;
} {
  const form = new PostDetailRealtimeElement('form', { class: formClass }, '', document);
  const textarea = new PostDetailRealtimeElement(
    'textarea',
    { id: textareaId, name: 'content' },
    '',
    document,
  );
  const button = new PostDetailRealtimeElement(
    'button',
    { type: 'button', class: 'preview-toggle', 'data-preview-for': textareaId },
    'Preview',
    document,
  );
  form.appendChild(textarea);
  form.appendChild(button);
  document.conversation().appendChild(form);
  return { form, textarea, button };
}

function requirePostDetailRealtimeElement(
  document: PostDetailRealtimeDocument,
  id: string,
): PostDetailRealtimeElement {
  const element = document.getElementById(id);
  expect(element).not.toBeNull();
  if (element === null) throw new Error(`expected element ${id}`);
  return element;
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
  fetchResponse: (url: string, init?: PostDetailFetchInit) => Promise<PostDetailFetchResponse>,
  fetchInits?: PostDetailFetchInit[],
): string[] {
  const fetches: string[] = [];
  PostDetailRealtimeEventSource.instances = [];
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'EventSource', {
    value: PostDetailRealtimeEventSource,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: (url: string, init?: PostDetailFetchInit) => {
      fetches.push(url);
      if (fetchInits) fetchInits.push(init ?? {});
      return fetchResponse(url, init);
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
    expect(detail.html).toContain('new EventSource("/events")');
    expect(detail.html).toContain(ACTIVITY_EVENT_TYPES.commentCreated);
    expect(detail.html).toContain(ACTIVITY_EVENT_TYPES.replyCreated);

    const script = extractPostDetailRealtimeScript(detail.html);
    const document = new PostDetailRealtimeDocument();
    const fetches = installPostDetailRealtimeGlobals(document, async (url) => {
      const res = await a.request(url, { headers: headersFor(ada.id, workspace.id) });
      return { ok: res.status === 200, text: () => res.text() };
    });

    Function(script)();
    const source = currentPostDetailEventSource();
    expect(source.url).toBe('/events');
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

    const fragmentUrl = '/feed/post1/fragments/conversation';
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

  it('preserves top-level and nested composer drafts across a matching realtime refresh', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost(
      'post1',
      workspace.id,
      ada.id,
      'Realtime draft preservation post',
      '2024-01-01T00:00:00.000Z',
    );
    seedComment({
      id: 'comment-draft-parent',
      workspaceId: workspace.id,
      rootPostId: 'post1',
      authorActorId: bo.id,
      content: 'reply target while drafting',
      createdAt: '2024-01-02T00:00:00.000Z',
    });
    const a = app();

    const detail = await getPostDetail(a, 'post1', ada.id, workspace.id);
    expect(detail.status).toBe(200);

    const script = extractPostDetailRealtimeScript(detail.html);
    const document = new PostDetailRealtimeDocument();
    const topComposer = appendPostDetailRealtimeComposer(
      document,
      'comment-composer',
      'new-comment',
    );
    const replyTextareaId = 'reply-comment-draft-parent';
    const replyComposer = appendPostDetailRealtimeComposer(
      document,
      'reply-composer',
      replyTextareaId,
    );
    topComposer.textarea.value = 'unsent top-level comment draft';
    replyComposer.textarea.value = 'unsent nested reply draft';
    replyComposer.textarea.focus();
    replyComposer.textarea.setSelectionRange(7, 13, 'forward');

    let topPreviewClicks = 0;
    let replyPreviewClicks = 0;
    topComposer.button.addEventListener('click', () => {
      topPreviewClicks += 1;
    });
    replyComposer.button.addEventListener('click', () => {
      replyPreviewClicks += 1;
    });

    const fetches = installPostDetailRealtimeGlobals(document, async (url) => {
      const res = await a.request(url, { headers: headersFor(ada.id, workspace.id) });
      return { ok: res.status === 200, text: () => res.text() };
    });

    Function(script)();
    const source = currentPostDetailEventSource();

    seedComment({
      id: 'comment-arrived-while-drafting',
      workspaceId: workspace.id,
      rootPostId: 'post1',
      authorActorId: ada.id,
      content: 'arrived while drafting',
      createdAt: '2024-01-03T00:00:00.000Z',
    });
    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, {
      rootPostId: 'post1',
      rootPostLastActivityAt: '2024-01-03T00:00:00.000Z',
    });
    await flushPromises();

    const fragmentUrl = '/feed/post1/fragments/conversation';
    expect(fetches).toEqual([fragmentUrl]);
    expect(document.conversation().innerHTML).toContain('arrived while drafting');

    const topAfter = requirePostDetailRealtimeElement(document, 'new-comment');
    const replyAfter = requirePostDetailRealtimeElement(document, replyTextareaId);
    expect(topAfter).toBe(topComposer.textarea);
    expect(replyAfter).toBe(replyComposer.textarea);
    expect(topAfter.value).toBe('unsent top-level comment draft');
    expect(replyAfter.value).toBe('unsent nested reply draft');
    expect(document.activeElement).toBe(replyComposer.textarea);
    expect(replyAfter.selectionStart).toBe(7);
    expect(replyAfter.selectionEnd).toBe(13);
    expect(replyAfter.selectionDirection).toBe('forward');

    const topButtonAfter = topAfter.closest('form')?.querySelector('button');
    const replyButtonAfter = replyAfter.closest('form')?.querySelector('button');
    expect(topButtonAfter).toBe(topComposer.button);
    expect(replyButtonAfter).toBe(replyComposer.button);
    if (!topButtonAfter || !replyButtonAfter) {
      throw new Error('expected preserved composer buttons');
    }
    topButtonAfter.click();
    replyButtonAfter.click();
    expect(topPreviewClicks).toBe(1);
    expect(replyPreviewClicks).toBe(1);
  });

  it('binds preview controls for reply composers introduced by a realtime refresh', async () => {
    const { workspace, ada, bo } = workspaceFixture();
    seedPost(
      'post1',
      workspace.id,
      ada.id,
      'Realtime preview rebind post',
      '2024-01-01T00:00:00.000Z',
    );
    const a = app();
    const detail = await getPostDetail(a, 'post1', ada.id, workspace.id);
    expect(detail.status).toBe(200);

    const script = extractPostDetailRealtimeScript(detail.html);
    const document = new PostDetailRealtimeDocument();
    const fetchInits: PostDetailFetchInit[] = [];
    const fetches = installPostDetailRealtimeGlobals(
      document,
      async (url) => {
        if (url === '/feed/preview') {
          return { ok: true, text: async () => '<p>rendered realtime preview</p>' };
        }
        const res = await a.request(url, { headers: headersFor(ada.id, workspace.id) });
        return { ok: res.status === 200, text: () => res.text() };
      },
      fetchInits,
    );

    Function(PREVIEW_SCRIPT)();
    Function(script)();
    const source = currentPostDetailEventSource();

    seedComment({
      id: 'comment-new-preview-parent',
      workspaceId: workspace.id,
      rootPostId: 'post1',
      authorActorId: bo.id,
      content: 'fresh parent with new reply composer',
      createdAt: '2024-01-02T00:00:00.000Z',
    });
    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, {
      rootPostId: 'post1',
      rootPostLastActivityAt: '2024-01-02T00:00:00.000Z',
    });
    await flushPromises();

    const fragmentUrl = '/feed/post1/fragments/conversation';
    expect(fetches).toEqual([fragmentUrl]);
    const freshTextareaId = 'reply-comment-new-preview-parent';
    const freshTextarea = requirePostDetailRealtimeElement(document, freshTextareaId);
    freshTextarea.value = 'preview from fresh composer';
    const freshForm = freshTextarea.closest('form');
    const freshButton = freshForm?.querySelector(
      '.preview-toggle[data-preview-for="reply-comment-new-preview-parent"]',
    );
    const freshPane = freshForm?.querySelector(
      '.composer-preview[data-preview-for="reply-comment-new-preview-parent"]',
    );
    expect(freshButton).not.toBeNull();
    expect(freshPane).not.toBeNull();
    if (!freshButton || !freshPane) {
      throw new Error('expected fresh reply composer preview controls');
    }

    freshButton.click();
    expect(freshPane.innerHTML).toBe('<span class="preview-label">Preview…</span>');
    await flushPromises();

    expect(fetches).toEqual([fragmentUrl, '/feed/preview']);
    expect(fetchInits[1]).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'content=preview+from+fresh+composer',
    });
    expect(freshPane.innerHTML).toBe(
      '<span class="preview-label">Preview</span><p>rendered realtime preview</p>',
    );
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
    const fragmentUrl = '/feed/post1/fragments/conversation';
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
