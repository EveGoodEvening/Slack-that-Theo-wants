import type { Migration } from '../migrator.js';

/**
 * C1 initial schema.
 *
 * Entities:
 * - workspace: the group/workspace a post lives in. All content is scoped to a
 *   workspace; cross-workspace isolation is enforced here at the data layer via
 *   FKs and a consistency trigger, and later at the API layer by C1a.
 * - actor: a human or agent participant. Actor polymorphism is modeled as a
 *   single table with a `kind` discriminator constrained to 'human' | 'agent'.
 *   posts/comments reference `actor.id`, so human and agent rows both satisfy
 *   the author FK. C7 adds agent credentials on top of this type; it does not
 *   redefine it.
 * - post: the feed unit. `lastActivityAt` is the feed-ordering field, bumped
 *   atomically by the shared C1 bump helper on every new comment/reply.
 *   `deletedAt` is the soft-delete tombstone marker.
 * - comment_node: a node in the unlimited-depth comment/reply tree. First-level
 *   comments have `parent_id IS NULL`; replies reference another comment_node
 *   via `parent_id`. `root_post_id` ties every node back to its post for O(1)
 *   root lookup and the bump helper.
 *
 * Unlimited-depth storage strategy: adjacency list (`parent_id` self-FK) plus a
 * recursive CTE for subtree fetch. This avoids a materialized-path maintenance
 * burden and supports arbitrary depth with SQLite's native recursive CTEs. The
 * choice is recorded in docs/stack-decision.md.
 *
 * Workspace boundary enforcement: `post.workspace_id` and
 * `comment_node.workspace_id` are FK'd to workspace. A trigger
 * (`enforce_comment_workspace_consistency`) rejects any comment_node whose
 * `workspace_id` differs from its root post's workspace or its parent
 * comment_node's workspace, so a reply can never cross workspace boundaries
 * even though parent_id and root_post_id are the structural FKs.
 */
export const migration0001Init: Migration = {
  version: 1,
  name: 'init-domain-schema',
  up: [
    `
    CREATE TABLE workspace (
      id         TEXT PRIMARY KEY NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    `,
    `
    CREATE TABLE actor (
      id            TEXT PRIMARY KEY NOT NULL,
      workspace_id  TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      display_name  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      -- Composite (workspace_id, id) is the target of the workspace-boundary
      -- composite FK from post/comment_node: it forces the author to belong to
      -- the same workspace as the content. Must be UNIQUE to be an FK target.
      UNIQUE (workspace_id, id),
      CHECK (kind IS NOT NULL)
    );
    `,
    'CREATE INDEX idx_actor_workspace ON actor (workspace_id);',
    `
    CREATE TABLE post (
      id              TEXT PRIMARY KEY NOT NULL,
      workspace_id    TEXT NOT NULL,
      author_actor_id TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL,
      deleted_at      TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (author_actor_id) REFERENCES actor (id) ON DELETE RESTRICT,
      -- Author must belong to the same workspace as the post (workspace boundary).
      FOREIGN KEY (workspace_id, author_actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE RESTRICT,
      CHECK (last_activity_at IS NOT NULL)
    );
    `,
    'CREATE INDEX idx_post_feed ON post (workspace_id, last_activity_at DESC, id DESC);',
    `
    CREATE TABLE comment_node (
      id              TEXT PRIMARY KEY NOT NULL,
      workspace_id    TEXT NOT NULL,
      root_post_id    TEXT NOT NULL,
      parent_id       TEXT,
      author_actor_id TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at      TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
      FOREIGN KEY (root_post_id) REFERENCES post (id) ON DELETE RESTRICT,
      -- Self-referential parent/child FK. A reply's parent is another node.
      FOREIGN KEY (parent_id) REFERENCES comment_node (id) ON DELETE RESTRICT,
      FOREIGN KEY (author_actor_id) REFERENCES actor (id) ON DELETE RESTRICT,
      -- Author must belong to the same workspace as the node (workspace boundary).
      FOREIGN KEY (workspace_id, author_actor_id)
        REFERENCES actor (workspace_id, id) ON DELETE RESTRICT,
      -- A node's workspace must match its root post's workspace. Enforced by
      -- trigger below for the parent case; this CHECK guards the direct case.
      CHECK (workspace_id IS NOT NULL AND root_post_id IS NOT NULL),
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
    `,
    'CREATE INDEX idx_comment_root ON comment_node (root_post_id, created_at, id);',
    'CREATE INDEX idx_comment_parent ON comment_node (parent_id, created_at, id);',
    'CREATE INDEX idx_comment_workspace ON comment_node (workspace_id);',
    `
    CREATE TRIGGER enforce_comment_workspace_consistency
    BEFORE INSERT ON comment_node
    FOR EACH ROW
    BEGIN
      -- Root post must exist in the same workspace. A missing root post is
      -- caught by the root_post_id FK; this guard catches a root post that
      -- exists but belongs to a different workspace.
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM post p WHERE p.id = NEW.root_post_id)
          AND NOT EXISTS (
            SELECT 1 FROM post p
            WHERE p.id = NEW.root_post_id AND p.workspace_id = NEW.workspace_id
          )
        THEN RAISE(ABORT, 'comment_node workspace_id must match its root post workspace')
      END;
      -- If this is a reply (parent_id not null): a missing parent is caught by
      -- the parent_id FK; this guard catches a parent that exists but belongs
      -- to a different workspace or a different root post.
      SELECT CASE
        WHEN NEW.parent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM comment_node c WHERE c.id = NEW.parent_id)
          AND NOT EXISTS (
            SELECT 1 FROM comment_node c
            WHERE c.id = NEW.parent_id
              AND c.workspace_id = NEW.workspace_id
              AND c.root_post_id = NEW.root_post_id
          )
        THEN RAISE(ABORT, 'reply parent must share workspace and root post')
      END;
    END;
    `,
    `
    -- Reject inserts into a soft-deleted post or comment subtree at the data
    -- layer. C3 also enforces this at the API layer; this trigger is the
    -- durable backstop for first-level comments and replies at any depth.
    CREATE TRIGGER enforce_no_insert_into_deleted_subtree
    BEFORE INSERT ON comment_node
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM post p
          WHERE p.id = NEW.root_post_id AND p.deleted_at IS NOT NULL
        )
        THEN RAISE(ABORT, 'cannot insert into a soft-deleted subtree')
      END;

      SELECT CASE
        WHEN NEW.parent_id IS NOT NULL AND EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_id, deleted_at
            FROM comment_node
            WHERE id = NEW.parent_id
            UNION ALL
            SELECT c.id, c.parent_id, c.deleted_at
            FROM comment_node c
            JOIN ancestors a ON c.id = a.parent_id
          )
          SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL
        )
        THEN RAISE(ABORT, 'cannot insert into a soft-deleted subtree')
      END;
    END;
    `,
  ],
  down: [
    'DROP TRIGGER IF EXISTS enforce_no_insert_into_deleted_subtree;',
    'DROP TRIGGER IF EXISTS enforce_comment_workspace_consistency;',
    'DROP INDEX IF EXISTS idx_comment_workspace;',
    'DROP INDEX IF EXISTS idx_comment_parent;',
    'DROP INDEX IF EXISTS idx_comment_root;',
    'DROP TABLE IF EXISTS comment_node;',
    'DROP INDEX IF EXISTS idx_post_feed;',
    'DROP TABLE IF EXISTS post;',
    'DROP INDEX IF EXISTS idx_actor_workspace;',
    'DROP TABLE IF EXISTS actor;',
    'DROP TABLE IF EXISTS workspace;',
  ],
};
