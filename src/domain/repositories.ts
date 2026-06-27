import type { BetterSqliteDatabase } from '../db/connection.js';
import type {
  Actor,
  ActorKind,
  CommentNode,
  CommentTombstone,
  CommentView,
  Post,
  PostTombstone,
  PostView,
  Workspace,
} from './types.js';

/**
 * C1 repository layer.
 *
 * Owns the durable post/comment/reply tree operations and the single shared
 * post-activity bump helper. C2 (post feed) and C3 (comment/reply API) MUST
 * reuse `bumpPostLastActivity` and the transactional create functions here —
 * they must not invent competing bump logic (plan assumption 4, C1 checklist).
 */

// ---------------------------------------------------------------------------
// Shared post-activity bump helper
// ---------------------------------------------------------------------------

/**
 * Atomically bump a post's `lastActivityAt` to at least `at`.
 *
 * This is the SINGLE shared bump helper owned by C1. Every new comment/reply
 * must update the root post's `lastActivityAt` through this function, inside
 * the same transaction as the insert, so the feed-ordering invariant is a
 * data-layer guarantee rather than a caller convention. The bump is monotonic:
 * out-of-order older activity never moves the feed-ordering field backward.
 *
 * Returns the number of rows touched (0 if the post does not exist).
 */
export function bumpPostLastActivity(
  db: BetterSqliteDatabase,
  postId: string,
  at: string,
): number {
  const info = db
    .prepare(
      `UPDATE post
       SET last_activity_at = CASE
         WHEN last_activity_at < ? THEN ?
         ELSE last_activity_at
       END
       WHERE id = ?`,
    )
    .run(at, at, postId);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Repository encapsulating C1 durable operations over a single DB connection.
 * Methods are intentionally thin SQL wrappers; transactional invariants (the
 * bump helper running with the insert) are baked into the create methods.
 */
export class DomainRepository {
  constructor(private readonly db: BetterSqliteDatabase) {}

  // --- workspace -----------------------------------------------------------

  createWorkspace(input: { id: string; slug: string; name: string }): Workspace {
    this.db
      .prepare(
        'INSERT INTO workspace (id, slug, name) VALUES (?, ?, ?)',
      )
      .run(input.id, input.slug, input.name);
    const created = this.getWorkspace(input.id);
    if (created === undefined) {
      throw new Error(`createWorkspace: insert of ${input.id} did not persist`);
    }
    return created;
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db
      .prepare('SELECT id, slug, name, created_at AS createdAt FROM workspace WHERE id = ?')
      .get(id) as Workspace | undefined;
    return row;
  }

  // --- actor ---------------------------------------------------------------

  createActor(input: {
    id: string;
    workspaceId: string;
    kind: ActorKind;
    displayName: string;
  }): Actor {
    this.db
      .prepare(
        'INSERT INTO actor (id, workspace_id, kind, display_name) VALUES (?, ?, ?, ?)',
      )
      .run(input.id, input.workspaceId, input.kind, input.displayName);
    const created = this.getActor(input.id);
    if (created === undefined) {
      throw new Error(`createActor: insert of ${input.id} did not persist`);
    }
    return created;
  }

  getActor(id: string): Actor | undefined {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, kind, display_name AS displayName,
                created_at AS createdAt
         FROM actor WHERE id = ?`,
      )
      .get(id) as Actor | undefined;
    return row;
  }

  // --- post ----------------------------------------------------------------

  createPost(input: {
    id: string;
    workspaceId: string;
    authorActorId: string;
    content: string;
    /** Initial feed-ordering timestamp; usually the post creation time. */
    lastActivityAt: string;
  }): Post {
    this.db
      .prepare(
        `INSERT INTO post (id, workspace_id, author_actor_id, content, last_activity_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.authorActorId,
        input.content,
        input.lastActivityAt,
      );
    const created = this.getPost(input.id);
    if (created === undefined) {
      throw new Error(`createPost: insert of ${input.id} did not persist`);
    }
    if ('isDeleted' in created) {
      throw new Error(`createPost: insert of ${input.id} unexpectedly returned a tombstone`);
    }
    return created;
  }

  getPost(id: string): PostView | undefined {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, author_actor_id AS authorActorId,
                content, created_at AS createdAt,
                last_activity_at AS lastActivityAt, deleted_at AS deletedAt
         FROM post WHERE id = ?`,
      )
      .get(id) as Post | undefined;
    if (row === undefined) return undefined;
    if (row.deletedAt !== null) {
      const tombstone: PostTombstone = {
        id: row.id,
        workspaceId: row.workspaceId,
        deletedAt: row.deletedAt,
        isDeleted: true,
      };
      return tombstone;
    }
    return row;
  }

  /**
   * Soft-delete a post: set `deletedAt` without removing the row. Children
   * (comment_node rows) are preserved so the tree structure survives and the
   * post can be returned as a tombstone.
   */
  softDeletePost(id: string, at: string): number {
    return this.db
      .prepare('UPDATE post SET deleted_at = ? WHERE id = ?')
      .run(at, id).changes;
  }

  /**
   * List live posts in one workspace using the C2 feed order. The workspace and
   * live-post predicates are applied before the composite cursor and ORDER BY,
   * so out-of-scope rows never participate in pagination.
   */
  listPostsInWorkspace(
    workspaceId: string,
    limit: number,
    cursor?: { lastActivityAt: string; postId: string },
  ): Post[] {
    if (cursor === undefined) {
      return this.db
        .prepare(
          `SELECT id, workspace_id AS workspaceId, author_actor_id AS authorActorId,
                  content, created_at AS createdAt,
                  last_activity_at AS lastActivityAt, deleted_at AS deletedAt
           FROM post
           WHERE workspace_id = @workspaceId
             AND deleted_at IS NULL
           ORDER BY last_activity_at DESC, id DESC
           LIMIT @limit`,
        )
        .all({ workspaceId, limit }) as Post[];
    }

    return this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, author_actor_id AS authorActorId,
                content, created_at AS createdAt,
                last_activity_at AS lastActivityAt, deleted_at AS deletedAt
         FROM post
         WHERE workspace_id = @workspaceId
           AND deleted_at IS NULL
           AND (
             last_activity_at < @cursorLastActivityAt
             OR (last_activity_at = @cursorLastActivityAt AND id < @cursorPostId)
           )
         ORDER BY last_activity_at DESC, id DESC
         LIMIT @limit`,
      )
      .all({
        workspaceId,
        limit,
        cursorLastActivityAt: cursor.lastActivityAt,
        cursorPostId: cursor.postId,
      }) as Post[];
  }

  /** Count live comment/reply nodes under one post for C2 read-post metadata. */
  countCommentsForPost(rootPostId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM comment_node
         WHERE root_post_id = ? AND deleted_at IS NULL`,
      )
      .get(rootPostId) as { count: number };
    return row.count;
  }

  /** Count live first-level comments under one post for C2 read-post metadata. */
  countFirstLevelCommentsForPost(rootPostId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM comment_node
         WHERE root_post_id = ?
           AND parent_id IS NULL
           AND deleted_at IS NULL`,
      )
      .get(rootPostId) as { count: number };
    return row.count;
  }


  // --- comment / reply -----------------------------------------------------

  /**
   * Create a first-level comment on a post. Atomically bumps the root post's
   * `lastActivityAt` via the shared bump helper inside the same transaction.
   */
  createComment(input: {
    id: string;
    workspaceId: string;
    rootPostId: string;
    authorActorId: string;
    content: string;
    createdAt: string;
  }): CommentNode {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO comment_node (id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workspaceId,
          input.rootPostId,
          input.authorActorId,
          input.content,
          input.createdAt,
        );
      const changes = bumpPostLastActivity(this.db, input.rootPostId, input.createdAt);
      if (changes !== 1) {
        throw new Error(`bumpPostLastActivity: post ${input.rootPostId} not found`);
      }
    });
    insert();
    const created = this.getComment(input.id);
    if (created === undefined) {
      throw new Error(`createComment: insert of ${input.id} did not persist`);
    }
    if ('isDeleted' in created) {
      throw new Error(`createComment: insert of ${input.id} unexpectedly returned a tombstone`);
    }
    return created;
  }

  /**
   * Create a reply to an existing comment_node at arbitrary depth. Atomically
   * bumps the root post's `lastActivityAt` via the shared bump helper inside
   * the same transaction. Rejects inserts into a soft-deleted subtree
   * (trigger-enforced).
   */
  createReply(input: {
    id: string;
    workspaceId: string;
    rootPostId: string;
    parentId: string;
    authorActorId: string;
    content: string;
    createdAt: string;
  }): CommentNode {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO comment_node (id, workspace_id, root_post_id, parent_id, author_actor_id, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workspaceId,
          input.rootPostId,
          input.parentId,
          input.authorActorId,
          input.content,
          input.createdAt,
        );
      const changes = bumpPostLastActivity(this.db, input.rootPostId, input.createdAt);
      if (changes !== 1) {
        throw new Error(`bumpPostLastActivity: post ${input.rootPostId} not found`);
      }
    });
    insert();
    const created = this.getComment(input.id);
    if (created === undefined) {
      throw new Error(`createReply: insert of ${input.id} did not persist`);
    }
    if ('isDeleted' in created) {
      throw new Error(`createReply: insert of ${input.id} unexpectedly returned a tombstone`);
    }
    return created;
  }

  getComment(id: string): CommentView | undefined {
    return this.getCommentRowAsView(this.getCommentRow(id));
  }

  private getCommentRow(id: string): CommentNode | undefined {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, root_post_id AS rootPostId,
                parent_id AS parentId, author_actor_id AS authorActorId,
                content, created_at AS createdAt, deleted_at AS deletedAt
         FROM comment_node WHERE id = ?`,
      )
      .get(id) as CommentNode | undefined;
    return row;
  }

  private getCommentRowAsView(row: CommentNode | undefined): CommentView | undefined {
    if (row === undefined) return undefined;
    if (row.deletedAt !== null) {
      const tombstone: CommentTombstone = {
        id: row.id,
        rootPostId: row.rootPostId,
        parentId: row.parentId,
        deletedAt: row.deletedAt,
        isDeleted: true,
      };
      return tombstone;
    }
    return row;
  }

  /**
   * Soft-delete a comment/reply node: set `deletedAt` without removing the row.
   * Children are preserved (no cascade) so the tree structure survives and the
   * node can be returned as a tombstone.
   */
  softDeleteComment(id: string, at: string): number {
    return this.db
      .prepare('UPDATE comment_node SET deleted_at = ? WHERE id = ?')
      .run(at, id).changes;
  }

  /**
   * Fetch a comment node as a live node or a tombstone view. Soft-deleted nodes
   * return a tombstone with redacted author/content while preserving id,
   * parent/root linkage, and children (fetched separately).
   */
  getCommentView(id: string): CommentView | undefined {
    return this.getComment(id);
  }

  /**
   * Fetch an entire subtree under a root node (inclusive) using a recursive
   * CTE — the unlimited-depth read path. Returns nodes in depth-first order
   * with depth metadata. Soft-deleted nodes are returned as tombstones so
   * callers see preserved structure with redacted content.
   */
  getSubtree(rootId: string): { node: CommentView; depth: number }[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree AS (
           SELECT id, workspace_id, root_post_id, parent_id, author_actor_id,
                  content, created_at, deleted_at, 0 AS depth,
                  created_at || char(31) || id AS sort_path
           FROM comment_node
           WHERE id = ?
           UNION ALL
           SELECT c.id, c.workspace_id, c.root_post_id, c.parent_id,
                  c.author_actor_id, c.content, c.created_at, c.deleted_at,
                  s.depth + 1 AS depth,
                  s.sort_path || char(30) || c.created_at || char(31) || c.id AS sort_path
           FROM comment_node c
           JOIN subtree s ON c.parent_id = s.id
         )
         SELECT id, workspace_id AS workspaceId, root_post_id AS rootPostId,
                parent_id AS parentId, author_actor_id AS authorActorId,
                content, created_at AS createdAt, deleted_at AS deletedAt, depth
         FROM subtree
         ORDER BY sort_path`,
      )
      .all(rootId) as (CommentNode & { depth: number })[];

    return rows.map((row) => {
      if (row.deletedAt !== null) {
        const tombstone: CommentTombstone = {
          id: row.id,
          rootPostId: row.rootPostId,
          parentId: row.parentId,
          deletedAt: row.deletedAt,
          isDeleted: true,
        };
        return { node: tombstone, depth: row.depth };
      }
      const { depth: _depth, ...live } = row;
      return { node: live, depth: row.depth };
    });
  }

  /**
   * Fetch all first-level comments (parent_id IS NULL) for a post, in stable
   * sibling order: createdAt ASC, id ASC.
   */
  getFirstLevelComments(rootPostId: string): CommentView[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, root_post_id AS rootPostId,
                parent_id AS parentId, author_actor_id AS authorActorId,
                content, created_at AS createdAt, deleted_at AS deletedAt
         FROM comment_node
         WHERE root_post_id = ? AND parent_id IS NULL
         ORDER BY created_at, id`,
      )
      .all(rootPostId) as CommentNode[];

    return rows.map((row) =>
      row.deletedAt !== null
        ? ({
            id: row.id,
            rootPostId: row.rootPostId,
            parentId: row.parentId,
            deletedAt: row.deletedAt,
            isDeleted: true,
          } satisfies CommentTombstone)
        : row,
    );
  }
}
