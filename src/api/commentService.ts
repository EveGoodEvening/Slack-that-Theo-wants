import type { DomainRepository } from '../domain/repositories.js';
import {
  isCommentTombstone,
  isPostTombstone,
  type CommentNode,
  type CommentView,
} from '../domain/types.js';
import {
  commentCreatedActivityEvent,
  noopActivityEventPublisher,
  replyCreatedActivityEvent,
  type ActivityEventPublisher,
} from './activityEvents.js';
import {
  assertCanRead,
  assertCanWrite,
  type Principal,
} from '../security/index.js';

/**
 * C3 comment/reply service.
 *
 * Owns first-level comment creation, arbitrary-depth reply creation, and the
 * subtree / full-thread read paths. Every write delegates to the C1
 * `DomainRepository.createComment` / `createReply` methods, which run the
 * shared `bumpPostLastActivity` helper inside the same transaction as the
 * insert — C3 never reimplements bump logic (plan assumption 4).
 *
 * Reply-target context (`replyToActorId`) is the author of the parent node.
 * It is derived at read time from the parent's `authorActorId` rather than
 * stored on a separate column, so the C1 schema stays the single source of
 * truth for the tree and the target context is always consistent with the
 * live parent. A first-level comment has `replyToActorId: null`. For a reply
 * whose parent has been soft-deleted, the parent's author is redacted by the
 * tombstone contract, so `replyToActorId` is null — the reply itself remains
 * retrievable with its own author/content intact.
 *
 * Every method enforces the C1a workspace/group boundary against the caller's
 * principal BEFORE any read or write, so out-of-scope posts/comments are never
 * touched. Soft-deleted parents reject new replies at the API layer (the
 * durable trigger is the data-layer backstop).
 */

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** A live comment/reply as returned by the C3 surface. */
export interface CommentDTO {
  id: string;
  workspaceId: string;
  rootPostId: string;
  parentId: string | null;
  authorActorId: string;
  content: string;
  createdAt: string;
  /**
   * The actor being replied to: the parent node's author. Null for a
   * first-level comment, and null when the parent has been soft-deleted (its
   * author is redacted by the tombstone contract). Preserved and queryable via
   * the subtree / thread fetch so clients can show reply-target context
   * without clogging the main post.
   */
  replyToActorId: string | null;
}

/** A soft-deleted comment/reply returned as a tombstone. */
export interface CommentTombstoneDTO {
  id: string;
  rootPostId: string;
  parentId: string | null;
  deletedAt: string;
  isDeleted: true;
  /**
   * Reply-target context is null for a tombstone: the redacted node's author
   * is not exposed. Children remain retrievable so the tree structure survives.
   */
  replyToActorId: null;
}

/** Discriminated union of a live or tombstoned comment/reply DTO. */
export type CommentViewDTO = CommentDTO | CommentTombstoneDTO;

/** A node in the subtree/thread response, with depth and assembled children. */
export interface CommentTreeNode {
  node: CommentViewDTO;
  /** Depth from the subtree root (0 for the root itself). */
  depth: number;
  /** Children in stable sibling order: createdAt ASC, id ASC. */
  children: CommentTreeNode[];
}

/** Subtree response: the root node's tree, depth-first assembled. */
export interface SubtreeResult {
  root: CommentTreeNode;
}

/** Full-thread response: every first-level comment under a post, each with its
 * subtree assembled. */
export interface FullThreadResult {
  postId: string;
  comments: CommentTreeNode[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Comment/reply service interface. C7 (agent control plane) reuses this same
 * interface to create comments/replies and fetch subtrees as humans do.
 */
export interface CommentService {
  /** Create a first-level comment on a post. */
  createComment(input: {
    principal: Principal;
    postId: string;
    content: string;
    /** Optional id; generated when omitted. */
    id?: string;
    /** Optional creation timestamp; defaults to now. */
    createdAt?: string;
  }): CommentDTO;

  /** Create a reply to any existing comment/reply at arbitrary depth. */
  createReply(input: {
    principal: Principal;
    /** The comment/reply being replied to. */
    parentId: string;
    content: string;
    /** Optional id; generated when omitted. */
    id?: string;
    /** Optional creation timestamp; defaults to now. */
    createdAt?: string;
  }): CommentDTO;

  /** Fetch one comment/reply after enforcing the caller's read boundary. */
  getComment(input: { principal: Principal; commentId: string }): CommentViewDTO;

  /** Fetch a subtree rooted at one comment/reply (inclusive), depth-first. */
  getSubtree(input: { principal: Principal; commentId: string }): SubtreeResult;

  /** Fetch the full thread under a post: all first-level comments + subtrees. */
  getFullThread(input: { principal: Principal; postId: string }): FullThreadResult;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a comment/reply target is missing or soft-deleted. */
export class CommentNotFoundError extends Error {
  constructor(commentId: string) {
    super(`comment ${commentId} not found`);
    this.name = 'CommentNotFoundError';
  }
}

/** Thrown when a post target is missing or soft-deleted. */
export class PostNotFoundError extends Error {
  constructor(postId: string) {
    super(`post ${postId} not found`);
    this.name = 'PostNotFoundError';
  }
}

/** Thrown when a reply targets a soft-deleted parent (deleted subtree). */
export class DeletedParentError extends Error {
  constructor(parentId: string) {
    super(`cannot reply into a deleted subtree (parent ${parentId} is deleted)`);
    this.name = 'DeletedParentError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Hono-scoped comment service backed by the C1 DomainRepository. Constructed
 * with the repository; every call re-derives the principal's workspace scope so
 * the boundary check is never bypassed.
 */
export class CommentServiceImpl implements CommentService {
  constructor(
    private readonly repo: DomainRepository,
    private readonly activity: ActivityEventPublisher = noopActivityEventPublisher,
  ) {}

  createComment(input: {
    principal: Principal;
    postId: string;
    content: string;
    id?: string;
    createdAt?: string;
  }): CommentDTO {
    if (input.content.length === 0) {
      throw new Error('createComment: content must not be empty');
    }
    // Resolve the post first to learn its workspace, then enforce the boundary.
    const post = this.repo.getPost(input.postId);
    if (post === undefined) {
      throw new PostNotFoundError(input.postId);
    }
    // Boundary first: the principal may only write in the post's workspace.
    assertCanWrite(input.principal, post.workspaceId);
    if (isPostTombstone(post)) {
      // A deleted post cannot receive comments.
      throw new PostNotFoundError(input.postId);
    }
    const now = new Date().toISOString();
    const id = input.id ?? cryptoId();
    const node = this.repo.createComment({
      id,
      workspaceId: post.workspaceId,
      rootPostId: post.id,
      authorActorId: input.principal.actorId,
      content: input.content,
      createdAt: input.createdAt ?? now,
    });
    const dto = toDTO(node, null);
    this.activity.publish(
      commentCreatedActivityEvent({
        workspaceId: node.workspaceId,
        rootPostLastActivityAt: rootPostLastActivityAt(
          this.repo,
          node.rootPostId,
          node.createdAt,
        ),
        comment: {
          id: node.id,
          rootPostId: node.rootPostId,
          parentId: null,
          authorActorId: node.authorActorId,
          createdAt: node.createdAt,
          replyToActorId: null,
        },
      }),
    );
    return dto;
  }

  createReply(input: {
    principal: Principal;
    parentId: string;
    content: string;
    id?: string;
    createdAt?: string;
  }): CommentDTO {
    if (input.content.length === 0) {
      throw new Error('createReply: content must not be empty');
    }
    // Resolve the parent first to learn workspace/root and the reply target.
    const parent = this.repo.getComment(input.parentId);
    if (parent === undefined) {
      throw new CommentNotFoundError(input.parentId);
    }
    // Boundary first: the principal may only write in the parent's workspace.
    // A tombstone parent redacts workspaceId, so derive it from the root post.
    assertCanWrite(input.principal, commentWorkspaceId(parent, this.repo));
    // Deleted-parent behavior: reject replies into any soft-deleted subtree at
    // the API layer. The data-layer trigger is the durable backstop, but the
    // service preserves the C3 DeletedParentError/409 contract for descendants
    // below tombstoned ancestors and deleted root posts.
    if (isDeletedSubtree(parent, this.repo)) {
      throw new DeletedParentError(input.parentId);
    }
    if (isCommentTombstone(parent)) {
      // Unreachable after isDeletedSubtree, but keeps the live-parent projection typed.
      throw new DeletedParentError(input.parentId);
    }
    // The reply target is the parent's author. The parent is live here, so its
    // authorActorId is available; this is the preserved replyToActorId context.
    const replyToActorId = parent.authorActorId;
    const now = new Date().toISOString();
    const id = input.id ?? cryptoId();
    const node = this.repo.createReply({
      id,
      workspaceId: parent.workspaceId,
      rootPostId: parent.rootPostId,
      parentId: parent.id,
      authorActorId: input.principal.actorId,
      content: input.content,
      createdAt: input.createdAt ?? now,
    });
    const dto = toDTO(node, replyToActorId);
    this.activity.publish(
      replyCreatedActivityEvent({
        workspaceId: node.workspaceId,
        rootPostLastActivityAt: rootPostLastActivityAt(
          this.repo,
          node.rootPostId,
          node.createdAt,
        ),
        comment: {
          id: node.id,
          rootPostId: node.rootPostId,
          parentId: parent.id,
          authorActorId: node.authorActorId,
          createdAt: node.createdAt,
          replyToActorId,
        },
      }),
    );
    return dto;
  }

  getComment(input: { principal: Principal; commentId: string }): CommentViewDTO {
    const comment = this.repo.getComment(input.commentId);
    if (comment === undefined) {
      throw new CommentNotFoundError(input.commentId);
    }
    assertCanRead(input.principal, commentWorkspaceId(comment, this.repo));
    return viewToDTO(comment, rootExternalParentAuthorById(comment, this.repo));
  }

  getSubtree(input: { principal: Principal; commentId: string }): SubtreeResult {
    // Resolve the root to learn its workspace for the boundary check. A
    // soft-deleted root is a tombstone (redacted, no workspaceId), so derive
    // the workspace from its root post in that case.
    const root = this.repo.getComment(input.commentId);
    if (root === undefined) {
      throw new CommentNotFoundError(input.commentId);
    }
    const workspaceId = commentWorkspaceId(root, this.repo);
    assertCanRead(input.principal, workspaceId);
    const rows = this.repo.getSubtree(input.commentId);
    const externalParentAuthors = rootExternalParentAuthorById(root, this.repo);
    // rows is depth-first, sorted by sort_path which encodes
    // createdAt ASC, id ASC at every sibling level. Assemble into a tree.
    const tree = assembleTree(rows, externalParentAuthors);
    if (tree === undefined) {
      // Defensive: root existed above, so the subtree query must return it.
      throw new CommentNotFoundError(input.commentId);
    }
    return { root: tree };
  }

  getFullThread(input: { principal: Principal; postId: string }): FullThreadResult {
    const post = this.repo.getPost(input.postId);
    if (post === undefined) {
      throw new PostNotFoundError(input.postId);
    }
    assertCanRead(input.principal, post.workspaceId);
    // A deleted post still returns its preserved comment tree as tombstones +
    // children; the post itself is tombstoned in C2 read-post. C3's full-thread
    // returns the comment tree data regardless of post deletion state, since
    // children are preserved by the soft-delete contract. (A deleted post has
    // no new replies — the trigger blocks them — but existing replies remain.)
    const firstLevel = this.repo.getFirstLevelComments(input.postId);
    const comments: CommentTreeNode[] = [];
    for (const root of firstLevel) {
      const rows = this.repo.getSubtree(root.id);
      const tree = assembleTree(rows);
      if (tree !== undefined) {
        comments.push(tree);
      }
    }
    // First-level comments are already in stable sibling order from the
    // repository (createdAt ASC, id ASC); preserve that order.
    return { postId: input.postId, comments };
  }
}

function rootPostLastActivityAt(
  repo: DomainRepository,
  rootPostId: string,
  fallback: string,
): string {
  const post = repo.getPost(rootPostId);
  if (post !== undefined && !isPostTombstone(post)) {
    return post.lastActivityAt;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace id for a comment view. Live nodes carry it directly;
 * tombstones redact it, so derive it from the root post (which always carries
 * workspaceId, even as a PostTombstone). Throws CommentNotFoundError if the
 * root post is gone — should be unreachable while the comment row exists.
 */
function commentWorkspaceId(view: CommentView, repo: DomainRepository): string {
  if (!isCommentTombstone(view)) {
    return view.workspaceId;
  }
  const post = repo.getPost(view.rootPostId);
  if (post === undefined) {
    throw new CommentNotFoundError(view.rootPostId);
  }
  return post.workspaceId;
}

/**
 * Return true when `view` is inside a deleted subtree: the root post is
 * tombstoned, the node itself is a tombstone, or any ancestor comment is a
 * tombstone. Used before createReply so API callers see DeletedParentError
 * instead of the repository trigger's raw SQLite error.
 */
function isDeletedSubtree(view: CommentView, repo: DomainRepository): boolean {
  const post = repo.getPost(view.rootPostId);
  if (post === undefined) {
    throw new CommentNotFoundError(view.rootPostId);
  }
  if (isPostTombstone(post) || isCommentTombstone(view)) {
    return true;
  }

  let parentId = view.parentId;
  while (parentId !== null) {
    const ancestor = repo.getComment(parentId);
    if (ancestor === undefined) {
      throw new CommentNotFoundError(parentId);
    }
    if (isCommentTombstone(ancestor)) {
      return true;
    }
    parentId = ancestor.parentId;
  }
  return false;
}

/**
 * Seed reply-target lookup for subtree roots whose parent is outside the
 * returned subtree. A live external parent contributes its author; tombstoned
 * or missing parents contribute null to preserve redaction.
 */
function rootExternalParentAuthorById(
  root: CommentView,
  repo: DomainRepository,
): Map<string, string | null> {
  if (root.parentId === null) {
    return new Map();
  }
  const parent = repo.getComment(root.parentId);
  if (parent === undefined || isCommentTombstone(parent)) {
    return new Map([[root.parentId, null]]);
  }
  return new Map([[parent.id, parent.authorActorId]]);
}

/**
 * Map a live comment node to a DTO, attaching the reply-target actor id. The
 * caller supplies `replyToActorId` (the parent's author, or null for a
 * first-level comment) so the mapping stays a pure projection.
 */
function toDTO(node: CommentNode, replyToActorId: string | null): CommentDTO {
  return {
    id: node.id,
    workspaceId: node.workspaceId,
    rootPostId: node.rootPostId,
    parentId: node.parentId,
    authorActorId: node.authorActorId,
    content: node.content,
    createdAt: node.createdAt,
    replyToActorId,
  };
}

/** Map any CommentView to its DTO form, given the parent-author lookup. */
function viewToDTO(
  view: CommentView,
  parentAuthorById: Map<string, string | null>,
): CommentViewDTO {
  if (isCommentTombstone(view)) {
    return {
      id: view.id,
      rootPostId: view.rootPostId,
      parentId: view.parentId,
      deletedAt: view.deletedAt,
      isDeleted: true,
      replyToActorId: null,
    };
  }
  // replyToActorId is the parent's author. For a first-level comment the parent
  // is null, so replyToActorId is null. For a reply whose parent is deleted,
  // the parent's author is redacted (null in the lookup), so replyToActorId is
  // null — matching the tombstone contract.
  const replyToActorId =
    view.parentId === null ? null : (parentAuthorById.get(view.parentId) ?? null);
  return toDTO(view, replyToActorId);
}

/**
 * Assemble a flat depth-first list of `{ node, depth }` rows (as produced by
 * `DomainRepository.getSubtree`, sorted by sort_path = createdAt ASC, id ASC at
 * each sibling level) into a nested tree. Returns the root node's tree, or
 * undefined if the input is empty.
 *
 * The repository's recursive-CTE sort_path already guarantees stable sibling
 * order (createdAt ASC, id ASC); this function preserves that order when
 * grouping children under their parent.
 */
function assembleTree(
  rows: { node: CommentView; depth: number }[],
  initialParentAuthorById: Map<string, string | null> = new Map(),
): CommentTreeNode | undefined {
  if (rows.length === 0) return undefined;

  // Build a lookup of every node's author so replyToActorId can be derived for
  // live children. The caller may seed an external parent for subtree roots.
  // Deleted nodes contribute null (redacted author).
  const parentAuthorById = new Map(initialParentAuthorById);
  for (const row of rows) {
    if (isCommentTombstone(row.node)) {
      parentAuthorById.set(row.node.id, null);
    } else {
      parentAuthorById.set(row.node.id, row.node.authorActorId);
    }
  }

  // The first row is the root (depth 0). Walk the depth-first list and attach
  // each subsequent node to its parent using a stack of pending parents.
  const firstRow = rows[0];
  if (!firstRow) return undefined;
  const root: CommentTreeNode = {
    node: viewToDTO(firstRow.node, parentAuthorById),
    depth: 0,
    children: [],
  };
  const stack: CommentTreeNode[] = [root];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const { node, depth } = row;
    // Pop until the stack top is the parent (depth - 1).
    let top = stack[stack.length - 1];
    while (top && top.depth >= depth) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    const parent = stack[stack.length - 1];
    if (!parent) continue;
    const child: CommentTreeNode = {
      node: viewToDTO(node, parentAuthorById),
      depth,
      children: [],
    };
    parent.children.push(child);
    stack.push(child);
  }
  return root;
}

/** Generate a comment id. Uses crypto.randomUUID when available. */
function cryptoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
