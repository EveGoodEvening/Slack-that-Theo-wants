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
import { bumpPostLastActivity } from '../domain/repositories.js';
import { MembershipRepository } from '../security/membership.js';
import { AuthRepository, sessionCookie } from '../security/auth.js';
import { createApp, type AppDeps } from '../index.js';
import { ACTIVITY_EVENT_TYPES } from '../api/activityEvents.js';

/**
 * C4 minimal human UI tests.
 *
 * Covers the plan's "Required verification":
 * - creating a post appears at the top of the feed
 * - the UI does not override API ordering (feed follows API response order)
 * - unsafe HTML/script in post content is escaped/sanitized on the feed and
 *   post-creation surfaces (via the C3a renderer)
 *
 * The feed UI is server-rendered HTML over the C2 PostService, so these are
 * HTTP-level tests against the mounted /feed route using `app.request()`.
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

/** Two-workspace fixture: wsA and wsB, each with one human writer. */
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

async function getFeed(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
): Promise<{ status: number; html: string }> {
  const res = await appInstance.request('/feed', {
    headers: headersFor(actorId, workspaceId),
  });
  return { status: res.status, html: await res.text() };
}

/** Submit the create-post form with the sign-in session cookie. */
async function createPostViaForm(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ status: number; html: string }> {
  const form = new URLSearchParams();
  form.set('content', content);
  const res = await appInstance.request('/feed', {
    method: 'POST',
    headers: { ...headersFor(actorId, workspaceId), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { status: res.status, html: await res.text() };
}

// ---------------------------------------------------------------------------

describe('C4 feed view', () => {
  it('renders the empty state when the workspace has no posts', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const { status, html } = await getFeed(a, humanA.id, wsA.id);
    expect(status).toBe(200);
    expect(html).toContain('feed-empty');
    expect(html).toContain('No posts yet');
  });

  it('renders posts in API response order (no client re-sort)', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    // Seed three posts with descending lastActivityAt. The C2 feed orders by
    // lastActivityAt DESC, postId DESC, so the API returns p3, p2, p1.
    seedPost('p1', wsA.id, humanA.id, 'first post', '2026-01-01T00:00:00.000Z');
    seedPost('p2', wsA.id, humanA.id, 'second post', '2026-01-02T00:00:00.000Z');
    seedPost('p3', wsA.id, humanA.id, 'third post', '2026-01-03T00:00:00.000Z');

    const a = app();
    const { status, html } = await getFeed(a, humanA.id, wsA.id);
    expect(status).toBe(200);

    // The feed HTML must list post bodies in the same order as the API: p3,
    // p2, p1. Assert by index of the rendered content text.
    const idx3 = html.indexOf('third post');
    const idx2 = html.indexOf('second post');
    const idx1 = html.indexOf('first post');
    expect(idx3).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx3);
    expect(idx1).toBeGreaterThan(idx2);
  });

  it('does not re-sort: a bumped older post stays where the API puts it', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    // p1 created first (older activity), then p2 newer. Then bump p1's
    // lastActivityAt above p2 via a direct repository update so the API now
    // returns p1 before p2. The UI must reflect that API order, not creation
    // order.
    seedPost('p1', wsA.id, humanA.id, 'older-bumped', '2026-01-01T00:00:00.000Z');
    seedPost('p2', wsA.id, humanA.id, 'newer', '2026-01-02T00:00:00.000Z');
    bumpPostLastActivity(db, 'p1', '2026-01-03T00:00:00.000Z');

    const a = app();
    const { html } = await getFeed(a, humanA.id, wsA.id);
    const idxBumped = html.indexOf('older-bumped');
    const idxNewer = html.indexOf('newer');
    expect(idxBumped).toBeGreaterThan(-1);
    expect(idxBumped).toBeLessThan(idxNewer);
  });
});

describe('C10 feed accessibility and error states', () => {
  it('renders feed landmarks, labels, and live status regions', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('p1', wsA.id, humanA.id, 'accessible post', '2026-01-01T00:00:00.000Z');

    const { status, html } = await getFeed(app(), humanA.id, wsA.id);

    expect(status).toBe(200);
    expect(html).toContain('<a class="skip-link" href="#main-content">Skip to main content</a>');
    expect(html).toContain('<main id="main-content" tabindex="-1">');
    expect(html).toContain('<section class="feed" id="feed" aria-labelledby="feed-heading" aria-live="polite" aria-busy="false">');
    expect(html).toContain('<h2 id="feed-heading" class="sr-only">Posts</h2>');
    expect(html).toContain('aria-describedby="create-post-help create-post-status"');
    expect(html).toContain('aria-controls="create-post-preview"');
    expect(html).toContain('id="create-post-status" class="form-status" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('aria-label="Post by humanA; last activity 2026-01-01T00:00:00.000Z"');
    expect(html).toContain('aria-label="View conversation for post by humanA"');
    expect(html).toContain('data-realtime-status="idle" role="status" aria-live="polite" aria-atomic="true"');
  });

  it('renders GET /feed missing-principal failures as an accessible error document', async () => {
    twoWorkspaceFixture();

    const res = await app().request('/feed');
    const html = await res.text();

    expect(res.status).toBe(401);
    expect(html).toContain('<main id="main-content" tabindex="-1">');
    expect(html).toContain('class="feed-error" role="alert" aria-live="assertive"');
    expect(html).toContain('missing_principal');
    expect(html).toContain('<a href="/auth/signin">Sign in</a>');
  });
});

describe('C4 create post appears in feed', () => {
  it('creates a post via the form and it appears at the top of the feed', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('old', wsA.id, humanA.id, 'pre-existing', '2026-01-01T00:00:00.000Z');

    const a = app();
    const { status, html } = await createPostViaForm(
      a,
      humanA.id,
      wsA.id,
      'fresh post from form',
    );
    expect(status).toBe(201);
    // The new post is the most recent, so it renders before the pre-existing
    // post in API order.
    const idxFresh = html.indexOf('fresh post from form');
    const idxOld = html.indexOf('pre-existing');
    expect(idxFresh).toBeGreaterThan(-1);
    expect(idxFresh).toBeLessThan(idxOld);
    expect(html).toContain('Post created.');
  });

  it('rejects empty content with 400 and re-renders the feed', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const { status, html } = await createPostViaForm(a, humanA.id, wsA.id, '');
    expect(status).toBe(400);
    expect(html).toContain('feed-error');
    expect(html).toContain('content must be a non-empty string');
  });

  it('rejects a missing principal with a 401 error document', async () => {
    twoWorkspaceFixture();
    const a = app();
    const form = new URLSearchParams();
    form.set('content', 'anon');
    const res = await a.request('/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('feed-error');
    expect(html).toContain('missing_principal');
  });

  it('rejects a read-only principal with 403 write_forbidden and creates no post', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');
    const a = app();

    const { status, html } = await createPostViaForm(a, humanA.id, wsA.id, 'no write');

    expect(status).toBe(403);
    expect(html).toContain('feed-error');
    expect(html).toContain('write_forbidden');
    expect(domain.listPostsInWorkspace(wsA.id, 10)).toEqual([]);
  });
});

describe('C4 unsafe HTML/script is escaped/sanitized', () => {
  it('escapes a <script> payload in post content on the feed surface', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const payload = '<script>alert("xss")</script>';
    const { status, html } = await createPostViaForm(a, humanA.id, wsA.id, payload);
    expect(status).toBe(201);
    // The raw <script> tag must never appear verbatim in the rendered HTML.
    expect(html).not.toContain('<script>alert("xss")</script>');
    // The C3a renderer escapes user text, so the angle brackets are escaped.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script>alert\("xss"\)<\/script>/);
  });

  it('sanitizes a javascript: link in post content on the feed surface', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const payload = '[click](javascript:alert(1))';
    const { html } = await createPostViaForm(a, humanA.id, wsA.id, payload);
    // The javascript: scheme must be dropped by the C3a renderer; no href with
    // a javascript: scheme may appear in the rendered feed.
    expect(html).not.toMatch(/href="javascript:/i);
    // The literal text is still escaped (no raw execution surface).
    expect(html).toContain('click');
  });

  it('escapes an iframe/onerror payload in post content on the feed surface', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    const payload = '<iframe srcdoc="<script>alert(1)</script>"></iframe><img src=x onerror=alert(1)>';
    const { html } = await createPostViaForm(a, humanA.id, wsA.id, payload);
    // The escaped payload may remain visible as text, but it must not create
    // live iframe/img elements or event-handler attributes in real tags.
    expect(html).not.toMatch(/<\s*(?:iframe|img)\b/i);
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    // The raw payload text is escaped, not interpreted as HTML.
    expect(html).toContain('&lt;iframe');
    expect(html).toContain('&lt;img');
  });

  it('escapes unsafe HTML in the create-post form error surface', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const a = app();
    // Submit empty content with a valid session so the route re-renders the
    // form error surface. The unsafe content is user-authored and must not be
    // emitted as raw HTML.
    const form = new URLSearchParams();
    form.set('content', '<script>alert(1)</script>');
    const res = await a.request('/feed/preview', {
      method: 'POST',
      headers: { ...headersFor(humanA.id, wsA.id), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never emits raw stored content on the feed — only C3a-rendered HTML', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    // Seed a post with raw HTML directly via the repository (bypassing the
    // form) to simulate stored malicious content. The feed must route it
    // through renderPostContent and escape it.
    seedPost(
      'evil',
      wsA.id,
      humanA.id,
      '<b>bold</b><script>alert(1)</script>',
      '2026-01-01T00:00:00.000Z',
    );
    const a = app();
    const { html } = await getFeed(a, humanA.id, wsA.id);
    // Raw stored <script> must never appear verbatim.
    expect(html).not.toContain('<script>alert(1)</script>');
    // The C3a renderer escapes the angle brackets of the raw HTML text.
    expect(html).toContain('&lt;script&gt;');
    // The literal <b> tags from stored content are escaped too (the renderer
    // only emits its own fixed tag set, never user-supplied tags).
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });
});

type FeedRealtimeMessage = { data: string };
type FeedRealtimeListener = (message: FeedRealtimeMessage) => void;
type FeedFetchResponse = { ok: boolean; text(): Promise<string> };
type FeedRealtimePostSeed = string | { postId: string; lastActivityAt?: string };

class FeedRealtimeEventSource {
  static instances: FeedRealtimeEventSource[] = [];
  readonly listeners = new Map<string, FeedRealtimeListener[]>();

  constructor(readonly url: string) {
    FeedRealtimeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: FeedRealtimeListener): void {
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

class FeedRealtimeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FeedRealtimeElement[] = [];
  parent: FeedRealtimeElement | null = null;
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

  appendChild(child: FeedRealtimeElement): void {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
  }

  insertBefore(child: FeedRealtimeElement, referenceChild: FeedRealtimeElement): void {
    if (child.parent) child.parent.removeChild(child);
    const index = this.children.indexOf(referenceChild);
    child.parent = this;
    if (index >= 0) {
      this.children.splice(index, 0, child);
      return;
    }
    this.children.push(child);
  }

  prepend(child: FeedRealtimeElement): void {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.unshift(child);
  }

  removeChild(child: FeedRealtimeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
  }

  remove(): void {
    if (this.parent) this.parent.removeChild(this);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): FeedRealtimeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  matches(selector: string): boolean {
    const postId = selector.match(/^\[data-post-id="([^"]+)"\]$/)?.[1];
    if (postId !== undefined) return this.getAttribute('data-post-id') === postId;
    if (selector === '.feed-empty') return this.hasClass('feed-empty');
    return false;
  }

  private hasClass(className: string): boolean {
    return (this.getAttribute('class') ?? '').split(/\s+/).includes(className);
  }
}

class FeedRealtimeTemplateElement extends FeedRealtimeElement {
  readonly content: { firstElementChild: FeedRealtimeElement | null } = {
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
    const postId = value.match(/data-post-id="([^"]+)"/)?.[1];
    const lastActivityAt = value.match(/data-last-activity-at="([^"]+)"/)?.[1];
    if (postId === undefined) {
      this.content.firstElementChild = null;
      return;
    }
    const attrs: Record<string, string> = { 'data-post-id': postId };
    if (lastActivityAt !== undefined) attrs['data-last-activity-at'] = lastActivityAt;
    this.content.firstElementChild = new FeedRealtimeElement('article', attrs, value);
  }
}

class FeedRealtimeDocument {
  readonly feed = new FeedRealtimeElement('section', { id: 'feed' });
  readonly status = new FeedRealtimeElement('p', { 'data-realtime-status': 'idle' });

  constructor(posts: FeedRealtimePostSeed[]) {
    for (const post of posts) {
      const postId = typeof post === 'string' ? post : post.postId;
      const attrs: Record<string, string> = { 'data-post-id': postId };
      if (typeof post !== 'string' && post.lastActivityAt !== undefined) {
        attrs['data-last-activity-at'] = post.lastActivityAt;
      }
      this.feed.appendChild(new FeedRealtimeElement('article', attrs));
    }
  }

  getElementById(id: string): FeedRealtimeElement | null {
    return id === 'feed' ? this.feed : null;
  }

  querySelector(selector: string): FeedRealtimeElement | null {
    if (selector === '[data-realtime-status]') return this.status;
    return this.feed.querySelector(selector);
  }

  createElement(tagName: string): FeedRealtimeElement {
    if (tagName.toLowerCase() === 'template') return new FeedRealtimeTemplateElement();
    return new FeedRealtimeElement(tagName);
  }

  postOrder(): string[] {
    return this.feed.children.map((child) => child.getAttribute('data-post-id') ?? '');
  }

  postCard(postId: string): FeedRealtimeElement {
    const card = this.feed.querySelector(`[data-post-id="${postId}"]`);
    expect(card).not.toBeNull();
    if (card === null) throw new Error(`expected post card ${postId}`);
    return card;
  }
}

function extractFeedRealtimeScript(html: string): string {
  const marker = '// C8 progressive enhancement: subscribe to scoped SSE activity.';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  if (start < 0) throw new Error('expected feed realtime script marker');
  const script = html.slice(start);
  const endMarker = '\n    })();';
  const end = script.indexOf(endMarker);
  expect(end).toBeGreaterThanOrEqual(0);
  if (end < 0) throw new Error('expected feed realtime script end');
  return script.slice(0, end + endMarker.length);
}

function installFeedRealtimeGlobals(
  document: FeedRealtimeDocument,
  fetchResponse: (url: string) => Promise<FeedFetchResponse>,
): string[] {
  const fetches: string[] = [];
  FeedRealtimeEventSource.instances = [];
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { CSS: { escape: (value: string) => value } },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'EventSource', {
    value: FeedRealtimeEventSource,
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

function currentFeedEventSource(): FeedRealtimeEventSource {
  const source = FeedRealtimeEventSource.instances[0];
  expect(source).toBeDefined();
  if (source === undefined) throw new Error('expected feed EventSource');
  return source;
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('C8 feed realtime progressive enhancement', () => {
  it('executes the SSE handler to replace and move a changed post card to the top', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('old', wsA.id, humanA.id, 'old post', '2024-01-01T00:00:00.000Z');
    seedPost('new', wsA.id, humanA.id, 'new post', '2024-01-02T00:00:00.000Z');
    const a = app();

    const before = await getFeed(a, humanA.id, wsA.id);
    expect(before.status).toBe(200);
    expect(before.html.indexOf('data-post-id="new"')).toBeLessThan(
      before.html.indexOf('data-post-id="old"'),
    );
    expect(before.html).toContain('new EventSource("/events")');
    expect(before.html).toContain(ACTIVITY_EVENT_TYPES.postCreated);
    expect(before.html).toContain(ACTIVITY_EVENT_TYPES.commentCreated);
    expect(before.html).toContain(ACTIVITY_EVENT_TYPES.replyCreated);

    const script = extractFeedRealtimeScript(before.html);
    const document = new FeedRealtimeDocument([
      { postId: 'new', lastActivityAt: '2024-01-02T00:00:00.000Z' },
      { postId: 'old', lastActivityAt: '2024-01-01T00:00:00.000Z' },
    ]);
    const fetches = installFeedRealtimeGlobals(document, async (url) => {
      const res = await a.request(url, { headers: headersFor(humanA.id, wsA.id) });
      return { ok: res.status === 200, text: () => res.text() };
    });

    Function(script)();
    const source = currentFeedEventSource();
    expect(source.url).toBe('/events');
    expect(source.listeners.has(ACTIVITY_EVENT_TYPES.commentCreated)).toBe(true);
    expect(source.listeners.has(ACTIVITY_EVENT_TYPES.postCreated)).toBe(true);
    expect(source.listeners.has(ACTIVITY_EVENT_TYPES.replyCreated)).toBe(true);
    const oldBefore = document.postCard('old');

    bumpPostLastActivity(db, 'old', '2024-01-03T00:00:00.000Z');
    const updated = domain.getPost('old');
    if (updated === undefined || 'isDeleted' in updated) {
      throw new Error('expected bumped live post');
    }

    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, { rootPostId: 'old' });
    await flushPromises();

    expect(fetches).toEqual(['/feed/fragments/posts/old']);
    expect(document.postOrder()).toEqual(['old', 'new']);
    const oldAfter = document.postCard('old');
    expect(oldAfter).not.toBe(oldBefore);
    expect(oldAfter.innerHTML).toContain(`datetime="${updated.lastActivityAt}"`);
    expect(document.status.textContent).toBe('Live updates connected.');
  });

  it('orders concurrent card fetches by activity timestamp when fragments resolve out of order', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const olderActivityAt = '2024-01-02T00:00:00.000Z';
    const newerActivityAt = '2024-01-03T00:00:00.000Z';
    seedPost('older', wsA.id, humanA.id, 'older update', olderActivityAt);
    seedPost('newer', wsA.id, humanA.id, 'newer update', newerActivityAt);
    const a = app();

    const before = await getFeed(a, humanA.id, wsA.id);
    expect(before.status).toBe(200);
    expect(before.html.indexOf('data-post-id="newer"')).toBeLessThan(
      before.html.indexOf('data-post-id="older"'),
    );

    const script = extractFeedRealtimeScript(before.html);
    const olderUrl = '/feed/fragments/posts/older';
    const newerUrl = '/feed/fragments/posts/newer';
    const olderFetch = deferred<FeedFetchResponse>();
    const newerFetch = deferred<FeedFetchResponse>();
    const document = new FeedRealtimeDocument([
      { postId: 'newer', lastActivityAt: newerActivityAt },
      { postId: 'older', lastActivityAt: olderActivityAt },
    ]);
    const fetches = installFeedRealtimeGlobals(document, (url) => {
      if (url === olderUrl) return olderFetch.promise;
      if (url === newerUrl) return newerFetch.promise;
      throw new Error(`unexpected feed fragment fetch ${url}`);
    });
    const fragmentResponse = async (postId: string): Promise<FeedFetchResponse> => {
      const res = await a.request(`/feed/fragments/posts/${postId}`, { headers: headersFor(humanA.id, wsA.id) });
      return { ok: res.status === 200, text: () => res.text() };
    };

    Function(script)();
    const source = currentFeedEventSource();
    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, {
      rootPostId: 'older',
      rootPostLastActivityAt: olderActivityAt,
    });
    source.emit(ACTIVITY_EVENT_TYPES.commentCreated, {
      rootPostId: 'newer',
      rootPostLastActivityAt: newerActivityAt,
    });
    expect(fetches).toEqual([olderUrl, newerUrl]);

    newerFetch.resolve(await fragmentResponse('newer'));
    await flushPromises();
    expect(document.postOrder()).toEqual(['newer', 'older']);

    olderFetch.resolve(await fragmentResponse('older'));
    await flushPromises();

    expect(document.postOrder()).toEqual(['newer', 'older']);
    expect(document.status.textContent).toBe('Live updates connected.');
  });

  it('announces feed fragment fetch failures in the live status region', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    seedPost('old', wsA.id, humanA.id, 'old post', '2024-01-01T00:00:00.000Z');
    const detail = await getFeed(app(), humanA.id, wsA.id);
    expect(detail.status).toBe(200);

    const script = extractFeedRealtimeScript(detail.html);
    const document = new FeedRealtimeDocument([
      { postId: 'old', lastActivityAt: '2024-01-01T00:00:00.000Z' },
    ]);
    const fetches = installFeedRealtimeGlobals(document, async () => ({
      ok: false,
      text: async () => 'network unavailable',
    }));

    Function(script)();
    currentFeedEventSource().emit(ACTIVITY_EVENT_TYPES.commentCreated, {
      rootPostId: 'old',
    });
    await flushPromises();

    expect(fetches).toEqual(['/feed/fragments/posts/old']);
    expect(document.status.textContent).toBe('Live updates paused; refresh to catch up.');
  });
});
