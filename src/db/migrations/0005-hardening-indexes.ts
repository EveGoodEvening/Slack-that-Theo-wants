import type { Migration } from '../migrator.js';

/**
 * C10 hardening indexes for the hot read paths.
 *
 * The base schema already has broad post/comment indexes. This migration adds
 * narrower indexes that match the exact production predicates C10 hardens:
 * live feed pagination (`workspace_id`, live rows only, activity order), live
 * comment counts, and first-level comment-tree roots. The recursive subtree
 * step continues to use the existing parent/created/id index because tombstones
 * must remain retrievable and therefore cannot use a live-only partial index.
 */
export const migration0005HardeningIndexes: Migration = {
  version: 5,
  name: 'hardening-hot-path-indexes',
  up: [
    `
    CREATE INDEX idx_post_feed_live
    ON post (workspace_id, last_activity_at DESC, id DESC)
    WHERE deleted_at IS NULL;
    `,
    `
    CREATE INDEX idx_comment_live_root_count
    ON comment_node (root_post_id)
    WHERE deleted_at IS NULL;
    `,
    `
    CREATE INDEX idx_comment_first_level_by_post
    ON comment_node (root_post_id, created_at, id)
    WHERE parent_id IS NULL;
    `,
  ],
  down: [
    'DROP INDEX IF EXISTS idx_comment_first_level_by_post;',
    'DROP INDEX IF EXISTS idx_comment_live_root_count;',
    'DROP INDEX IF EXISTS idx_post_feed_live;',
  ],
};
