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
import { PRINCIPAL_HEADERS } from '../security/principal.js';
import { createApp, type AppDeps } from '../index.js';

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

/** Submit the create-post form with browser hidden principal fields. */
async function createPostViaForm(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ status: number; html: string }> {
  const form = new URLSearchParams();
  form.set('content', content);
  form.set('actorId', actorId);
  form.set('workspaceId', workspaceId);
  const res = await appInstance.request('/feed', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
    // Submit empty content plus an invalid actor credential to trigger the
    // authorization error document. The actor value contains markup so the
    // test proves the form principal path validates through membership and
    // escapes rejected credential text in the UI error surface.
    const form = new URLSearchParams();
    form.set('content', '');
    form.set('actorId', `${humanA.id}\"><script>alert(1)</script>`);
    form.set('workspaceId', wsA.id);
    const res = await a.request('/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(401);
    // The injected script in the actor field must be escaped in the error page.
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
