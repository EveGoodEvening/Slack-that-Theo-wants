import type { DomainRepository } from '../domain/repositories.js';
import {
  isPostTombstone,
  type Post,
  type PostView,
} from '../domain/types.js';
import {
  assertCanRead,
  assertCanWrite,
  workspaceScopePredicate,
  type Principal,
} from '../security/index.js';

/**
 * C2 post feed service.
 *
 * Owns the post creation, feed listing, and read-post business logic. Every
 * method enforces the C1a workspace/group boundary against the caller's
 * principal BEFORE any ordering, pagination, or comment-tree metadata read so
 * out-of-scope rows are never touched. Feed ordering is the deterministic
 * composite `lastActivityAt DESC, postId DESC` defined in the plan; the cursor
 * encodes that composite so equal-`lastActivityAt` posts paginate without
 * duplicates or skips.
 *
 * Bump logic is NOT reimplemented here: post creation seeds `lastActivityAt`
 * and comment/reply activity bumps it through the shared C1 bump helper, which
 * C2's bump verification exercises by seeding comments directly via the C1
 * repository (not the C3 reply endpoint).
 */

/** A live post as returned by the feed / read-post surface. */
export interface PostDTO {
  id: string;
  workspaceId: string;
  authorActorId: string;
  content: string;
  createdAt: string;
  lastActivityAt: string;
}

/** Comment-tree metadata returned by read-post (not the full C3 subtree). */
export interface CommentTreeMeta {
  /** Total live comment/reply nodes under the post. */
  totalCount: number;
  /** Live first-level comments (parent_id IS NULL). */
  firstLevelCount: number;
}

/** Read-post response: the post plus comment-tree metadata. */
export interface ReadPostResult {
  post: PostDTO;
  comments: CommentTreeMeta;
}

/** A composite cursor encoding the deterministic feed order. */
export interface FeedCursor {
  lastActivityAt: string;
  postId: string;
}

/** One page of the feed. */
export interface FeedPage {
  posts: PostDTO[];
  /** Encoded cursor for the next page, or undefined if this page is the last. */
  nextCursor?: string;
}

/** Default and maximum page sizes for the feed. */
export const DEFAULT_FEED_LIMIT = 20;
export const MAX_FEED_LIMIT = 100;

function toDTO(post: Post): PostDTO {
  return {
    id: post.id,
    workspaceId: post.workspaceId,
    authorActorId: post.authorActorId,
    content: post.content,
    createdAt: post.createdAt,
    lastActivityAt: post.lastActivityAt,
  };
}

/**
 * Decode a base64url cursor string into the composite cursor. Returns undefined
 * for an empty/absent cursor (first page). Throws on a malformed cursor so the
 * API layer maps it to a 400.
 */
export function decodeCursor(raw: string | undefined): FeedCursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  const json = Buffer.from(raw, 'base64url').toString('utf8');
  const parsed = JSON.parse(json) as Partial<FeedCursor>;
  if (
    typeof parsed.lastActivityAt !== 'string' ||
    typeof parsed.postId !== 'string'
  ) {
    throw new Error('malformed feed cursor');
  }
  return { lastActivityAt: parsed.lastActivityAt, postId: parsed.postId };
}

/** Encode a composite cursor into a base64url string for clients. */
export function encodeCursor(cursor: FeedCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Post feed service interface. C7 (agent control plane) reuses this same
 * interface to create/list/read posts as humans do.
 */
export interface PostService {
  /** Create a post in the principal's workspace. */
  createPost(input: {
    principal: Principal;
    content: string;
    /** Optional id; generated when omitted. */
    id?: string;
    /** Optional initial activity timestamp; defaults to now. */
    lastActivityAt?: string;
  }): PostDTO;

  /** List a page of the feed for the principal's workspace. */
  listFeed(input: {
    principal: Principal;
    limit?: number;
    cursor?: FeedCursor;
  }): FeedPage;

  /** Read a single post plus comment-tree metadata. */
  readPost(input: { principal: Principal; postId: string }): ReadPostResult;
}

/**
 * Hono-scoped post service backed by the C1 DomainRepository. Constructed with
 * the repository; every call re-derives the principal's workspace scope so the
 * boundary check is never bypassed.
 */
export class PostServiceImpl implements PostService {
  constructor(private readonly repo: DomainRepository) {}

  createPost(input: {
    principal: Principal;
    content: string;
    id?: string;
    lastActivityAt?: string;
  }): PostDTO {
    if (input.content.length === 0) {
      throw new Error('createPost: content must not be empty');
    }
    // Boundary first: the principal may only write in its own workspace.
    assertCanWrite(input.principal, input.principal.workspaceId);
    const now = new Date().toISOString();
    const id = input.id ?? cryptoId();
    const post = this.repo.createPost({
      id,
      workspaceId: input.principal.workspaceId,
      authorActorId: input.principal.actorId,
      content: input.content,
      lastActivityAt: input.lastActivityAt ?? now,
    });
    return toDTO(post);
  }

  listFeed(input: {
    principal: Principal;
    limit?: number;
    cursor?: FeedCursor;
  }): FeedPage {
    // Boundary first: assert read role, then scope the query to the principal's
    // workspace via the shared C1a scope predicate. The repository applies this
    // workspace id as a WHERE predicate before ordering/pagination.
    assertCanRead(input.principal, input.principal.workspaceId);
    const inScope = workspaceScopePredicate({
      workspaceId: input.principal.workspaceId,
      role: input.principal.role,
    });
    // The predicate is the single source of truth for the authorized workspace;
    // feeding it the principal's workspace guarantees the query cannot target
    // any other workspace.
    const workspaceId = input.principal.workspaceId;
    if (!inScope(workspaceId)) {
      // Defensive: should be unreachable after assertCanRead, but keeps the
      // scope helper on the read path per the plan.
      return { posts: [] };
    }

    const limit = clampLimit(input.limit);
    const rows = this.repo.listPostsInWorkspace(
      workspaceId,
      limit + 1,
      input.cursor,
    );
    const pageRows = rows.slice(0, limit);
    const posts = pageRows.map(toDTO);
    const lastPost = pageRows[pageRows.length - 1];
    if (rows.length <= limit || lastPost === undefined) {
      return { posts };
    }
    return {
      posts,
      nextCursor: encodeCursor({
        lastActivityAt: lastPost.lastActivityAt,
        postId: lastPost.id,
      }),
    };
  }

  readPost(input: { principal: Principal; postId: string }): ReadPostResult {
    const view = this.repo.getPost(input.postId);
    if (view === undefined) {
      throw new PostNotFoundError(input.postId);
    }
    // Boundary first: authorize against the post's workspace before returning
    // any content or metadata. Tombstones still carry workspaceId for the check.
    assertCanRead(input.principal, view.workspaceId);
    if (isPostTombstone(view)) {
      throw new PostNotFoundError(input.postId);
    }
    const totalCount = this.repo.countCommentsForPost(view.id);
    const firstLevelCount = this.repo.countFirstLevelCommentsForPost(view.id);
    return {
      post: toDTO(view),
      comments: { totalCount, firstLevelCount },
    };
  }
}

/** Thrown when a read-post targets a missing or deleted post. */
export class PostNotFoundError extends Error {
  constructor(postId: string) {
    super(`post ${postId} not found`);
    this.name = 'PostNotFoundError';
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FEED_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('feed limit must be a positive integer');
  }
  return Math.min(limit, MAX_FEED_LIMIT);
}

/** Generate a post id. Uses crypto.randomUUID when available. */
function cryptoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `post-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Re-export the PostView type for route-layer tombstone handling. */
export type { PostView };
