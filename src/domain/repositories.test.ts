import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import {
  appliedMigrations,
  migrateDown,
  migrateUp,
  migrations,
  type BetterSqliteDatabase,
} from '../db/index.js';
import {
  bumpPostLastActivity,
  DomainRepository,
  isCommentTombstone,
  isPostTombstone,
} from './index.js';
import { MembershipRepository } from '../security/membership.js';

/**
 * C1 repository/schema tests.
 *
 * Covers the C1 "Required verification":
 * - migration applies cleanly and rolls back cleanly
 * - arbitrary-depth reply storage
 * - parent/child constraints (FK + workspace consistency)
 * - invalid parent rejection
 * - lastActivityAt updates on every nested reply via the shared bump helper
 * - soft-delete tombstone behavior (children preserved)
 * - actor polymorphism (human and agent rows satisfy the actor reference)
 */

let db: BetterSqliteDatabase;

beforeAll(() => {
  db = openDatabase(':memory:');
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  // Start each test from a clean schema by rolling back to zero then up.
  // migrateDown rolls back everything applied.
  let applied = appliedMigrations(db);
  while (applied.length > 0) {
    migrateDown(db, migrations, applied[applied.length - 1]);
    applied = appliedMigrations(db);
  }
  migrateUp(db, migrations);
});

/** Build a fresh workspace + human + agent + post fixture. */
function fixture(repo: DomainRepository) {
  const ws = repo.createWorkspace({ id: 'ws1', slug: 'team-a', name: 'Team A' });
  const human = repo.createActor({
    id: 'human1',
    workspaceId: ws.id,
    kind: 'human',
    displayName: 'Ada',
  });
  const agent = repo.createActor({
    id: 'agent1',
    workspaceId: ws.id,
    kind: 'agent',
    displayName: 'HelperBot',
  });
  const post = repo.createPost({
    id: 'post1',
    workspaceId: ws.id,
    authorActorId: human.id,
    content: 'First post',
    lastActivityAt: '2026-06-27T00:00:00.000Z',
  });
  return { ws, human, agent, post };
}

function expectLivePost(post: ReturnType<DomainRepository['getPost']>) {
  expect(post).toBeDefined();
  if (post === undefined) throw new Error('post missing');
  expect(isPostTombstone(post)).toBe(false);
  if (isPostTombstone(post)) throw new Error('expected live post');
  return post;
}

function expectLiveComment(comment: ReturnType<DomainRepository['getComment']>) {
  expect(comment).toBeDefined();
  if (comment === undefined) throw new Error('comment missing');
  expect(isCommentTombstone(comment)).toBe(false);
  if (isCommentTombstone(comment)) throw new Error('expected live comment');
  return comment;
}

describe('C1 migrations', () => {
  it('applies cleanly on a fresh database', () => {
    // Later chunks register additional migrations; a fresh DB applies the full chain.
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4]);
    // Core tables exist.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('workspace');
    expect(names).toContain('actor');
    expect(names).toContain('post');
    expect(names).toContain('comment_node');
    expect(names).toContain('schema_migrations');
  });

  it('rolls back cleanly to an empty schema', () => {
    migrateDown(db, migrations, 1);
    expect(appliedMigrations(db)).toEqual([]);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables
      .map((t) => t.name)
      .filter((name) => !name.startsWith('sqlite_'));
    // Only the migrations tracker remains (it is not owned by migration 1).
    expect(names).toEqual(['schema_migrations']);
  });

  it('is idempotent when re-applied after a rollback', () => {
    migrateDown(db, migrations, 1);
    migrateUp(db, migrations);
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4]);
    const repo = new DomainRepository(db);
    const { post } = fixture(repo);
    expect(post.id).toBe('post1');
  });
});

describe('C1 actor polymorphism', () => {
  it('stores human and agent actors in the same table with a kind discriminator', () => {
    const repo = new DomainRepository(db);
    const { human, agent } = fixture(repo);
    expect(human.kind).toBe('human');
    expect(agent.kind).toBe('agent');
    expect(repo.getActor(human.id)?.kind).toBe('human');
    expect(repo.getActor(agent.id)?.kind).toBe('agent');
  });

  it('rejects an actor with an invalid kind', () => {
    const repo = new DomainRepository(db);
    const { ws } = fixture(repo);
    expect(() =>
      repo.createActor({
        id: 'bad',
        workspaceId: ws.id,
        // @ts-expect-error -- intentionally invalid kind to exercise the CHECK
        kind: 'robot',
        displayName: 'Bad',
      }),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('a post and comment authored by an agent satisfy the actor reference identically to a human', () => {
    const repo = new DomainRepository(db);
    const { ws, agent, post } = fixture(repo);
    const comment = repo.createComment({
      id: 'c-agent',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: agent.id,
      content: 'agent reply',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    expect(comment.authorActorId).toBe(agent.id);
    // The FK to actor(id) resolved for an agent row — polymorphism holds.
    expect(expectLiveComment(repo.getComment(comment.id)).authorActorId).toBe(agent.id);
  });
});

describe('C1 parent/child constraints and arbitrary depth', () => {
  it('inserts a reply chain of arbitrary depth and preserves parent linkage', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);

    const root = repo.createComment({
      id: 'n0',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'depth 0',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    expect(root.parentId).toBeNull();

    let parentId = root.id;
    const DEPTH = 25;
    for (let i = 1; i <= DEPTH; i++) {
      const node = repo.createReply({
        id: `n${i}`,
        workspaceId: ws.id,
        rootPostId: post.id,
        parentId,
        authorActorId: human.id,
        content: `depth ${i}`,
        createdAt: `2026-06-27T00:00:${String(i + 1).padStart(2, '0')}.000Z`,
      });
      expect(node.parentId).toBe(parentId);
      expect(node.rootPostId).toBe(post.id);
      parentId = node.id;
    }

    // Recursive CTE fetches the whole subtree at arbitrary depth.
    const subtree = repo.getSubtree(root.id);
    expect(subtree).toHaveLength(DEPTH + 1);
    expect(subtree[DEPTH]?.depth).toBe(DEPTH);
    expect(subtree[DEPTH]?.node.id).toBe(`n${DEPTH}`);
  });

  it('preserves stable depth-first preorder for branching subtrees', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);

    const root = repo.createComment({
      id: 'root',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'root',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    const a = repo.createReply({
      id: 'a',
      workspaceId: ws.id,
      rootPostId: post.id,
      parentId: root.id,
      authorActorId: human.id,
      content: 'a',
      createdAt: '2026-06-27T00:00:02.000Z',
    });
    repo.createReply({
      id: 'b',
      workspaceId: ws.id,
      rootPostId: post.id,
      parentId: root.id,
      authorActorId: human.id,
      content: 'b',
      createdAt: '2026-06-27T00:00:03.000Z',
    });
    repo.createReply({
      id: 'a-1',
      workspaceId: ws.id,
      rootPostId: post.id,
      parentId: a.id,
      authorActorId: human.id,
      content: 'a child',
      createdAt: '2026-06-27T00:00:04.000Z',
    });

    expect(repo.getSubtree(root.id).map((entry) => entry.node.id)).toEqual([
      'root',
      'a',
      'a-1',
      'b',
    ]);
  });

  it('rejects a reply whose parent does not exist (FK violation)', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    expect(() =>
      repo.createReply({
        id: 'orphan',
        workspaceId: ws.id,
        rootPostId: post.id,
        parentId: 'nonexistent-parent',
        authorActorId: human.id,
        content: 'orphan reply',
        createdAt: '2026-06-27T00:00:01.000Z',
      }),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('rejects a self-parent reply node', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    expect(() =>
      db
        .prepare(
          `INSERT INTO comment_node
             (id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'self-parent',
          ws.id,
          post.id,
          'self-parent',
          human.id,
          'cycle',
          '2026-06-27T00:00:01.000Z',
        ),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('rejects a comment whose root post does not exist (FK violation)', () => {
    const repo = new DomainRepository(db);
    const { ws, human } = fixture(repo);
    // A first-level comment (no parent) pointing at a nonexistent root post
    // is rejected by the root_post_id FK directly.
    expect(() =>
      repo.createComment({
        id: 'bad-root',
        workspaceId: ws.id,
        rootPostId: 'nonexistent-post',
        authorActorId: human.id,
        content: 'bad root',
        createdAt: '2026-06-27T00:00:02.000Z',
      }),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('rejects a reply whose parent belongs to a different root post', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const post2 = repo.createPost({
      id: 'post2',
      workspaceId: ws.id,
      authorActorId: human.id,
      content: 'second post',
      lastActivityAt: '2026-06-27T00:00:00.000Z',
    });
    const rootOnPost2 = repo.createComment({
      id: 'root-p2',
      workspaceId: ws.id,
      rootPostId: post2.id,
      authorActorId: human.id,
      content: 'on post2',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    // Reply claims root_post_id = post1 but parent = a node on post2.
    expect(() =>
      repo.createReply({
        id: 'cross-root',
        workspaceId: ws.id,
        rootPostId: post.id,
        parentId: rootOnPost2.id,
        authorActorId: human.id,
        content: 'cross-root reply',
        createdAt: '2026-06-27T00:00:02.000Z',
      }),
    ).toThrowError(/reply parent must share workspace and root post/);
  });

  it('rejects a comment whose workspace differs from its root post workspace', () => {
    const repo = new DomainRepository(db);
    const { human, post } = fixture(repo);
    const ws2 = repo.createWorkspace({ id: 'ws2', slug: 'team-b', name: 'Team B' });
    expect(() =>
      repo.createComment({
        id: 'cross-ws',
        workspaceId: ws2.id,
        rootPostId: post.id,
        authorActorId: human.id,
        content: 'cross-workspace comment',
        createdAt: '2026-06-27T00:00:01.000Z',
      }),
    ).toThrowError(/comment_node workspace_id must match its root post workspace/);
  });

  it('allows a shared-workspace post author whose home workspace differs', () => {
    const repo = new DomainRepository(db);
    const { human } = fixture(repo);
    const ws2 = repo.createWorkspace({ id: 'ws2', slug: 'team-b', name: 'Team B' });
    const membership = new MembershipRepository(db);
    membership.createShare({
      workspaceId: ws2.id,
      actorId: human.id,
      role: 'write',
    });

    const post = repo.createPost({
      id: 'shared-workspace-post',
      workspaceId: ws2.id,
      authorActorId: human.id,
      content: 'cross-home shared post',
      lastActivityAt: '2026-06-27T00:00:00.000Z',
    });

    expect(post.workspaceId).toBe(ws2.id);
    expect(post.authorActorId).toBe(human.id);
  });
});

describe('C1 shared post-activity bump helper', () => {
  it('bumpPostLastActivity atomically updates the post ordering field', () => {
    const repo = new DomainRepository(db);
    const { post } = fixture(repo);
    const before = expectLivePost(repo.getPost(post.id)).lastActivityAt;
    const next = '2026-06-27T00:00:42.000Z';
    const changes = bumpPostLastActivity(db, post.id, next);
    expect(changes).toBe(1);
    const after = expectLivePost(repo.getPost(post.id)).lastActivityAt;
    expect(after).toBe(next);
    expect(after).not.toBe(before);
  });

  it('returns 0 when the post does not exist', () => {
    expect(bumpPostLastActivity(db, 'no-such-post', '2026-06-27T00:00:00.000Z')).toBe(0);
  });

  it('a first-level comment bumps the root post lastActivityAt via the shared helper', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const at = '2026-06-27T00:00:05.000Z';
    repo.createComment({
      id: 'c1',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'comment',
      createdAt: at,
    });
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe(at);
  });

  it('a nested reply at depth N bumps the root post lastActivityAt atomically', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);

    // Build a chain depth 0..10; each insert must bump the root post.
    const root = repo.createComment({
      id: 'd0',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'root comment',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe('2026-06-27T00:00:01.000Z');

    let parentId = root.id;
    for (let i = 1; i <= 10; i++) {
      const at = `2026-06-27T00:00:${String(i + 1).padStart(2, '0')}.000Z`;
      const node = repo.createReply({
        id: `d${i}`,
        workspaceId: ws.id,
        rootPostId: post.id,
        parentId,
        authorActorId: human.id,
        content: `depth ${i}`,
        createdAt: at,
      });
      // The bump is atomic with the insert: immediately readable.
      expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe(at);
      parentId = node.id;
    }

    // Final ordering field equals the deepest reply's timestamp.
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe('2026-06-27T00:00:11.000Z');
  });

  it('an agent-authored reply bumps the root post identically to a human reply', () => {
    const repo = new DomainRepository(db);
    const { ws, agent, post } = fixture(repo);
    const at = '2026-06-27T00:00:09.000Z';
    repo.createComment({
      id: 'agent-c',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: agent.id,
      content: 'agent bump',
      createdAt: at,
    });
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe(at);
  });

  it('does not regress lastActivityAt for out-of-order comments or replies', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const newest = '2026-06-27T00:00:10.000Z';
    const older = '2026-06-27T00:00:05.000Z';

    const comment = repo.createComment({
      id: 'newer-comment',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'newer comment',
      createdAt: newest,
    });
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe(newest);

    repo.createReply({
      id: 'older-reply',
      workspaceId: ws.id,
      rootPostId: post.id,
      parentId: comment.id,
      authorActorId: human.id,
      content: 'older reply',
      createdAt: older,
    });
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe(newest);

    repo.createComment({
      id: 'older-comment',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'older comment',
      createdAt: older,
    });
    expect(expectLivePost(repo.getPost(post.id)).lastActivityAt).toBe(newest);
  });
});

describe('C1 soft-delete tombstone behavior', () => {
  it('soft-deletes a comment node and returns it as a tombstone with redacted content', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const root = repo.createComment({
      id: 'root-c',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'will be deleted',
      createdAt: '2026-06-27T00:00:01.000Z',
    });

    const changes = repo.softDeleteComment(root.id, '2026-06-27T00:00:10.000Z');
    expect(changes).toBe(1);

    const view = repo.getCommentView(root.id);
    expect(view).toBeDefined();
    if (view === undefined) throw new Error('tombstone view missing');
    expect(isCommentTombstone(view)).toBe(true);
    if (isCommentTombstone(view)) {
      expect(view.deletedAt).toBe('2026-06-27T00:00:10.000Z');
      // Tombstone redacts author and content but preserves structure.
      expect((view as { authorActorId?: string }).authorActorId).toBeUndefined();
      expect((view as { content?: string }).content).toBeUndefined();
      expect(view.rootPostId).toBe(post.id);
      expect(view.parentId).toBeNull();
    }
  });

  it('redacts a soft-deleted comment through the public comment read', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const root = repo.createComment({
      id: 'public-read-c',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'public read must not expose this',
      createdAt: '2026-06-27T00:00:01.000Z',
    });

    repo.softDeleteComment(root.id, '2026-06-27T00:00:10.000Z');

    const comment = repo.getComment(root.id);
    expect(comment).toBeDefined();
    if (comment === undefined) throw new Error('public comment read missing');
    expect(isCommentTombstone(comment)).toBe(true);
    expect((comment as { authorActorId?: string }).authorActorId).toBeUndefined();
    expect((comment as { content?: string }).content).toBeUndefined();
  });

  it('preserves children of a soft-deleted node (no hard removal, no cascade)', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const root = repo.createComment({
      id: 'root-c',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'parent to delete',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    const child = repo.createReply({
      id: 'child-c',
      workspaceId: ws.id,
      rootPostId: post.id,
      parentId: root.id,
      authorActorId: human.id,
      content: 'surviving child',
      createdAt: '2026-06-27T00:00:02.000Z',
    });

    repo.softDeleteComment(root.id, '2026-06-27T00:00:10.000Z');

    // Child is still fully present and live.
    const childRow = expectLiveComment(repo.getComment(child.id));
    expect(childRow.deletedAt).toBeNull();
    expect(childRow.content).toBe('surviving child');

    // Subtree fetch returns the deleted parent as a tombstone plus the live child.
    const subtree = repo.getSubtree(root.id);
    expect(subtree).toHaveLength(2);
    const [deletedNode, liveNode] = subtree;
    if (!deletedNode || !liveNode) throw new Error('subtree missing expected nodes');
    expect(isCommentTombstone(deletedNode.node)).toBe(true);
    expect(liveNode.node.id).toBe(child.id);
    expect(isCommentTombstone(liveNode.node)).toBe(false);
  });

  it('soft-deletes a post and keeps it retrievable as a tombstone', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    // Add a comment so the post has a child to preserve.
    repo.createComment({
      id: 'c1',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'child comment',
      createdAt: '2026-06-27T00:00:01.000Z',
    });

    const changes = repo.softDeletePost(post.id, '2026-06-27T00:00:10.000Z');
    expect(changes).toBe(1);

    const deleted = repo.getPost(post.id);
    expect(deleted).toBeDefined();
    if (deleted === undefined) throw new Error('post tombstone missing');
    expect(isPostTombstone(deleted)).toBe(true);
    if (isPostTombstone(deleted)) {
      expect(deleted.deletedAt).toBe('2026-06-27T00:00:10.000Z');
      expect(deleted.workspaceId).toBe(ws.id);
      expect((deleted as { authorActorId?: string }).authorActorId).toBeUndefined();
      expect((deleted as { content?: string }).content).toBeUndefined();
      expect((deleted as { lastActivityAt?: string }).lastActivityAt).toBeUndefined();
    }

    const comments = repo.getFirstLevelComments(post.id);
    expect(comments).toHaveLength(1);
  });

  it('rejects a first-level comment under a soft-deleted post', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    repo.softDeletePost(post.id, '2026-06-27T00:00:10.000Z');

    expect(() =>
      repo.createComment({
        id: 'under-deleted-post',
        workspaceId: ws.id,
        rootPostId: post.id,
        authorActorId: human.id,
        content: 'comment under deleted post',
        createdAt: '2026-06-27T00:00:11.000Z',
      }),
    ).toThrowError(/cannot insert into a soft-deleted subtree/);
  });

  it('rejects a reply into a soft-deleted subtree (data-layer backstop)', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const root = repo.createComment({
      id: 'root-c',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'will delete',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    repo.softDeleteComment(root.id, '2026-06-27T00:00:10.000Z');

    expect(() =>
      repo.createReply({
        id: 'into-deleted',
        workspaceId: ws.id,
        rootPostId: post.id,
        parentId: root.id,
        authorActorId: human.id,
        content: 'reply into deleted',
        createdAt: '2026-06-27T00:00:11.000Z',
      }),
    ).toThrowError(/cannot insert into a soft-deleted subtree/);
  });

  it('rejects a reply under a deleted ancestor even when the direct parent is live', () => {
    const repo = new DomainRepository(db);
    const { ws, human, post } = fixture(repo);
    const root = repo.createComment({
      id: 'deleted-ancestor',
      workspaceId: ws.id,
      rootPostId: post.id,
      authorActorId: human.id,
      content: 'ancestor',
      createdAt: '2026-06-27T00:00:01.000Z',
    });
    const liveChild = repo.createReply({
      id: 'live-child',
      workspaceId: ws.id,
      rootPostId: post.id,
      parentId: root.id,
      authorActorId: human.id,
      content: 'live child',
      createdAt: '2026-06-27T00:00:02.000Z',
    });
    repo.softDeleteComment(root.id, '2026-06-27T00:00:10.000Z');

    expect(() =>
      repo.createReply({
        id: 'under-deleted-ancestor',
        workspaceId: ws.id,
        rootPostId: post.id,
        parentId: liveChild.id,
        authorActorId: human.id,
        content: 'blocked descendant',
        createdAt: '2026-06-27T00:00:11.000Z',
      }),
    ).toThrowError(/cannot insert into a soft-deleted subtree/);
  });
});
