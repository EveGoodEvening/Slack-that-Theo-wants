import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import { openDatabase } from './db/connection.js';
import {
  appliedMigrations,
  migrateDown,
  migrateUp,
  migrations,
  type BetterSqliteDatabase,
} from './db/index.js';
import { DomainRepository } from './domain/index.js';
import { AuthRepository, sessionCookie } from './security/auth.js';
import { MembershipRepository } from './security/membership.js';

const FEED_PAGINATION_BENCHMARK_POSTS = 500;
const FEED_PAGINATION_BENCHMARK_LIMIT = 37;
const DEEP_THREAD_BENCHMARK_DEPTH = 250;
const C10_BENCHMARK_THRESHOLD_MS = 1_500;

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


function headersFor(actorId: string, workspaceId: string): Record<string, string> {
  const session = auth.createSession({ actorId, workspaceId });
  return { cookie: sessionCookie(session.secret) };
}

function workspaceFixture(): { workspaceId: string; actorId: string } {
  const workspace = domain.createWorkspace({
    id: 'perf-ws',
    slug: 'perf',
    name: 'Performance Workspace',
  });
  const actor = domain.createActor({
    id: 'perf-human',
    workspaceId: workspace.id,
    kind: 'human',
    displayName: 'Perf Human',
  });
  return { workspaceId: workspace.id, actorId: actor.id };
}

function isoAt(offsetMs: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, offsetMs)).toISOString();
}

function queryPlanDetails(sql: string, params: Record<string, unknown>): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[];
  return rows.map((row) => row.detail).join('\n');
}

describe('C10 feed pagination performance and invariants', () => {
  it('paginates a large activity-ordered feed without duplicates or skips within the benchmark threshold', async () => {
    const { workspaceId, actorId } = workspaceFixture();
    const expected: Array<{ id: string; lastActivityAt: string }> = [];
    for (let i = 0; i < FEED_PAGINATION_BENCHMARK_POSTS; i += 1) {
      const id = `post-${String(i).padStart(4, '0')}`;
      const lastActivityAt = isoAt(Math.floor(i / 5));
      domain.createPost({
        id,
        workspaceId,
        authorActorId: actorId,
        content: `feed item ${i}`,
        lastActivityAt,
      });
      expected.push({ id, lastActivityAt });
    }
    expected.sort((left, right) => {
      const activityOrder = right.lastActivityAt.localeCompare(left.lastActivityAt);
      return activityOrder === 0 ? right.id.localeCompare(left.id) : activityOrder;
    });

    const a = createApp({ repository: domain, membership, auth });
    const headers = headersFor(actorId, workspaceId);
    const seen: string[] = [];
    let cursor: string | undefined;
    const startedAt = performance.now();
    do {
      const qs = new URLSearchParams({
        limit: String(FEED_PAGINATION_BENCHMARK_LIMIT),
      });
      if (cursor !== undefined) qs.set('cursor', cursor);
      const res = await a.request(`/posts?${qs.toString()}`, { headers });
      expect(res.status).toBe(200);
      const page = (await res.json()) as {
        posts: Array<{ id: string }>;
        nextCursor?: string;
      };
      seen.push(...page.posts.map((post) => post.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const elapsedMs = performance.now() - startedAt;

    expect(seen).toHaveLength(FEED_PAGINATION_BENCHMARK_POSTS);
    expect(new Set(seen).size).toBe(FEED_PAGINATION_BENCHMARK_POSTS);
    expect(seen).toEqual(expected.map((post) => post.id));
    expect(elapsedMs).toBeLessThan(C10_BENCHMARK_THRESHOLD_MS);
  });

  it('keeps the live feed query on the C10 feed index', () => {
    const plan = queryPlanDetails(
      `SELECT id, workspace_id, author_actor_id, content, created_at, last_activity_at, deleted_at
       FROM post
       WHERE workspace_id = @workspaceId
         AND deleted_at IS NULL
       ORDER BY last_activity_at DESC, id DESC
       LIMIT @limit`,
      { workspaceId: 'perf-ws', limit: 20 },
    );

    expect(plan).toContain('idx_post_feed_live');
  });
});

describe('C10 deep-thread rendering performance and invariants', () => {
  it('renders a pathological deep thread with the safeguard inside the benchmark threshold', async () => {
    const { workspaceId, actorId } = workspaceFixture();
    domain.createPost({
      id: 'deep-post',
      workspaceId,
      authorActorId: actorId,
      content: 'deep root post',
      lastActivityAt: isoAt(0),
    });
    domain.createComment({
      id: 'comment-0',
      workspaceId,
      rootPostId: 'deep-post',
      authorActorId: actorId,
      content: 'Depth zero',
      createdAt: isoAt(1),
    });
    let parentId = 'comment-0';
    for (let depth = 1; depth <= DEEP_THREAD_BENCHMARK_DEPTH; depth += 1) {
      const id = `reply-${depth}`;
      domain.createReply({
        id,
        workspaceId,
        rootPostId: 'deep-post',
        parentId,
        authorActorId: actorId,
        content: `Depth ${depth}`,
        createdAt: isoAt(depth + 1),
      });
      parentId = id;
    }

    const startedAt = performance.now();
    const res = await createApp({ repository: domain, membership, auth }).request('/feed/deep-post', {
      headers: headersFor(actorId, workspaceId),
    });
    const html = await res.text();
    const elapsedMs = performance.now() - startedAt;

    expect(res.status).toBe(200);
    expect(html).toContain('reply-depth-safeguard');
    expect(html).toContain('100+ deeper replies are collapsed');
    expect(html).toContain('Depth 8');
    expect(html).not.toContain('Depth 200');
    expect(html.length).toBeLessThan(80_000);
    expect(elapsedMs).toBeLessThan(C10_BENCHMARK_THRESHOLD_MS);
  });

  it('keeps comment-tree root and child lookups on the C10/comment parent indexes', () => {
    const firstLevelPlan = queryPlanDetails(
      `SELECT id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at, deleted_at
       FROM comment_node
       WHERE root_post_id = @rootPostId AND parent_id IS NULL
       ORDER BY created_at, id`,
      { rootPostId: 'deep-post' },
    );
    const childPlan = queryPlanDetails(
      `SELECT id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at, deleted_at
       FROM comment_node
       WHERE parent_id = @parentId
       ORDER BY created_at, id`,
      { parentId: 'comment-0' },
    );

    expect(firstLevelPlan).toContain('idx_comment_first_level_by_post');
    expect(childPlan).toContain('idx_comment_parent');
  });
});
