/**
 * C1 domain entity types. These mirror the durable schema in
 * src/db/migrations/0001-init.ts and are the single source of truth for the
 * actor polymorphism contract (human | agent discriminator).
 */

/** Actor kind discriminator. C7 adds agent credentials on top of this type. */
export type ActorKind = 'human' | 'agent';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface Actor {
  id: string;
  workspaceId: string;
  kind: ActorKind;
  displayName: string;
  createdAt: string;
}

export interface Post {
  id: string;
  workspaceId: string;
  authorActorId: string;
  content: string;
  createdAt: string;
  /** Feed-ordering field. Bumped atomically by the shared bump helper. */
  lastActivityAt: string;
  /** Soft-delete tombstone marker. Null while the post is live. */
  deletedAt: string | null;
}

export interface CommentNode {
  id: string;
  workspaceId: string;
  /** The post this node's tree belongs to. O(1) root lookup for the bump. */
  rootPostId: string;
  /** Parent comment_node id, or null for a first-level comment on the post. */
  parentId: string | null;
  authorActorId: string;
  content: string;
  createdAt: string;
  /** Soft-delete tombstone marker. Null while the node is live. */
  deletedAt: string | null;
}

/**
 * A comment_node rendered as a tombstone when soft-deleted: author/content are
 * redacted but the node (and its children) remain retrievable so the tree
 * structure is preserved. Repository read functions return this shape for any
 * row with `deletedAt != null`.
 */
export interface CommentTombstone {
  id: string;
  rootPostId: string;
  parentId: string | null;
  deletedAt: string;
  /** Marker so callers can distinguish tombstones from live nodes by shape. */
  isDeleted: true;
}

export interface PostTombstone {
  id: string;
  workspaceId: string;
  deletedAt: string;
  isDeleted: true;
}

/** Discriminated union of a live or tombstoned comment node. */
export type CommentView = CommentNode | CommentTombstone;

export function isCommentTombstone(node: CommentView): node is CommentTombstone {
  return (node as CommentTombstone).isDeleted === true;
}
