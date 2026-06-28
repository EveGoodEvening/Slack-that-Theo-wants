import type { DomainRepository } from '../domain/repositories.js';
import type { Actor, ActorKind } from '../domain/types.js';
import {
  DEFAULT_AGENT_QUOTA,
  IdempotencyKeyReuseError,
  requestDigest,
  type AgentAuditRepository,
  type AgentCredentialRepository,
  type AgentIdempotencyRepository,
  type AgentProfileRepository,
  type AgentQuotaRepository,
  type AgentWriteAction,
  type QuotaConfig,
} from '../security/index.js';
import type { Principal } from '../security/types.js';
import type {
  CommentDTO,
  CommentService,
  CommentViewDTO,
  FullThreadResult,
  SubtreeResult,
} from './commentService.js';
import {
  CommentNotFoundError,
  PostNotFoundError,
} from './commentService.js';
import type {
  FeedCursor,
  FeedPage,
  PostDTO,
  PostService,
  ReadPostResult,
} from './postService.js';

/**
 * C7 agent control-plane service.
 *
 * Wraps the existing C2 PostService and C3 CommentService so agents participate
 * in the same post/comment/reply tree as humans, through the same C1a
 * authorization boundaries. On top of the shared services it layers the C7
 * write-safety contract:
 *
 * - Idempotency keys: a replayed agent write with the same key returns the
 *   original result and does NOT create a duplicate or trigger a second feed
 *   bump.
 * - Audit logging: every agent create-post/comment/reply action is recorded.
 * - Rate limit / quota: excess agent writes are rejected before the write
 *   occurs (no duplicate write, no extra bump).
 *
 * It also exposes the machine-readable priority/status metadata contract
 * (per-post `lastActivityAt`, reply counts, active/unresolved status, actor
 * type) ordered by activity, least-privilege scoped to the caller's workspace
 * with no cross-workspace leakage.
 */


/** Result of an agent write: either a fresh result or an idempotency replay. */
export type AgentWriteResult<T> =
  | { result: T; replay: false }
  | { result: T; replay: true; action: AgentWriteAction };

/** A post status entry in the machine-readable priority/status metadata feed. */
export interface PostStatusEntry {
  id: string;
  workspaceId: string;
  authorActorId: string;
  /** Actor type of the author (human | agent), so agents can infer context. */
  authorKind: ActorKind;
  lastActivityAt: string;
  createdAt: string;
  /** Total live comment/reply nodes under the post. */
  replyCount: number;
  /** Live first-level comments. */
  firstLevelCount: number;
  /**
   * Active/unresolved status: 'active' while the post is live, 'resolved' is
   * not yet modeled (deferred), 'deleted' for tombstones (redacted). Agents
   * infer priorities from activity + counts without scraping UI text.
   */
  status: 'active' | 'deleted';
}

/** One page of the agent status metadata feed. */
export interface AgentStatusPage {
  posts: PostStatusEntry[];
  nextCursor?: string;
}

/** Redacted audit entry exposed to the acting agent. */
export interface AgentAuditEntry {
  id: number;
  action: AgentWriteAction;
  targetId: string;
  rootPostId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

/** Agent control-plane service dependencies. */
export interface AgentServiceDeps {
  repository: DomainRepository;
  postService: PostService;
  commentService: CommentService;
  credentials: AgentCredentialRepository;
  profiles: AgentProfileRepository;
  audit: AgentAuditRepository;
  idempotency: AgentIdempotencyRepository;
  quota: AgentQuotaRepository;
  /** Optional quota config; defaults to DEFAULT_AGENT_QUOTA. */
  quotaConfig?: QuotaConfig;
}

/** Header name for the client-supplied idempotency key on agent writes. */
export const IDEMPOTENCY_HEADER = 'x-idempotency-key';

export class AgentService {
  private readonly quotaConfig: QuotaConfig;

  constructor(private readonly deps: AgentServiceDeps) {
    this.quotaConfig = deps.quotaConfig ?? DEFAULT_AGENT_QUOTA;
  }

  // --- agent write: create post -------------------------------------------

  /**
   * Create a post as an agent. Enforces idempotency, quota, and audit logging
   * on top of the C2 PostService (which enforces the workspace boundary).
   */
  createPost(input: {
    principal: Principal;
    content: string;
    idempotencyKey?: string;
  }): AgentWriteResult<PostDTO> {
    return this.writeWithIdempotency(
      'create_post',
      input.principal,
      input.idempotencyKey,
      input.content,
      () => {
        this.checkQuota(input.principal);
        const post = this.deps.postService.createPost({
          principal: input.principal,
          content: input.content,
        });
        return { target: post, targetId: post.id, rootPostId: null };
      },
      (targetId) => this.deps.postService.readPost({ principal: input.principal, postId: targetId }).post,
    );
  }

  // --- agent write: create comment ----------------------------------------

  /**
   * Create a first-level comment as an agent. Enforces idempotency, quota, and
   * audit logging on top of the C3 CommentService.
   */
  createComment(input: {
    principal: Principal;
    postId: string;
    content: string;
    idempotencyKey?: string;
  }): AgentWriteResult<CommentDTO> {
    return this.writeWithIdempotency(
      'create_comment',
      input.principal,
      input.idempotencyKey,
      `${input.postId}|${input.content}`,
      () => {
        this.checkQuota(input.principal);
        const comment = this.deps.commentService.createComment({
          principal: input.principal,
          postId: input.postId,
          content: input.content,
        });
        return { target: comment, targetId: comment.id, rootPostId: comment.rootPostId };
      },
      (targetId) => {
        const view = this.deps.commentService.getComment({ principal: input.principal, commentId: targetId });
        if ('isDeleted' in view) {
          throw new CommentNotFoundError(targetId);
        }
        return view;
      },
    );
  }

  // --- agent write: create reply ------------------------------------------

  /**
   * Create a reply as an agent. Enforces idempotency, quota, and audit logging
   * on top of the C3 CommentService. The reply bumps the root post exactly as a
   * human reply does (via the shared C1 bump helper inside C3).
   */
  createReply(input: {
    principal: Principal;
    parentId: string;
    content: string;
    idempotencyKey?: string;
  }): AgentWriteResult<CommentDTO> {
    return this.writeWithIdempotency(
      'create_reply',
      input.principal,
      input.idempotencyKey,
      `${input.parentId}|${input.content}`,
      () => {
        this.checkQuota(input.principal);
        const reply = this.deps.commentService.createReply({
          principal: input.principal,
          parentId: input.parentId,
          content: input.content,
        });
        return { target: reply, targetId: reply.id, rootPostId: reply.rootPostId };
      },
      (targetId) => {
        const view = this.deps.commentService.getComment({ principal: input.principal, commentId: targetId });
        if ('isDeleted' in view) {
          throw new CommentNotFoundError(targetId);
        }
        return view;
      },
    );
  }

  // --- agent read: feed (machine-readable, least-privilege) ---------------

  /**
   * List a page of the feed for the agent's workspace. Delegates to the C2
   * PostService.listFeed, which scopes by the principal's workspace before
   * ordering/pagination — no cross-workspace leakage.
   */
  listFeed(input: {
    principal: Principal;
    limit?: number;
    cursor?: FeedCursor;
  }): FeedPage {
    return this.deps.postService.listFeed(input);
  }

  /** Read a single post + comment metadata (C2 read-post, workspace-scoped). */
  readPost(input: { principal: Principal; postId: string }): ReadPostResult {
    return this.deps.postService.readPost(input);
  }

  /** Fetch a subtree (C3, workspace-scoped). */
  getSubtree(input: { principal: Principal; commentId: string }): SubtreeResult {
    return this.deps.commentService.getSubtree(input);
  }

  /** Fetch the full thread under a post (C3, workspace-scoped). */
  getFullThread(input: { principal: Principal; postId: string }): FullThreadResult {
    return this.deps.commentService.getFullThread(input);
  }

  /** Fetch a single comment (C3, workspace-scoped). */
  getComment(input: { principal: Principal; commentId: string }): CommentViewDTO {
    return this.deps.commentService.getComment(input);
  }

  // --- agent read: priority/status metadata contract ----------------------

  /**
   * Machine-readable priority/status metadata feed, ordered by activity
   * (lastActivityAt DESC, postId DESC) — the same order as the human feed.
   * Each entry carries per-post `lastActivityAt`, reply counts, active/
   * unresolved status, and the author actor type (human | agent), so agents
   * can infer priorities without scraping UI text. Least-privilege scoped to
   * the caller's workspace; tombstones are redacted (no content/author name).
   */
  listStatus(input: {
    principal: Principal;
    limit?: number;
    cursor?: FeedCursor;
  }): AgentStatusPage {
    const page = this.deps.postService.listFeed(input);
    const posts = page.posts.map((post) => this.toStatusEntry(post));
    const result: AgentStatusPage = { posts };
    if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
    return result;
  }

  /** Status metadata for a single post (workspace-scoped, redacted tombstones). */
  readStatus(input: { principal: Principal; postId: string }): PostStatusEntry {
    const result = this.deps.postService.readPost(input);
    return this.toStatusEntry(result.post);
  }

  private toStatusEntry(post: PostDTO): PostStatusEntry {
    const actor = this.deps.repository.getActor(post.authorActorId);
    const replyCount = this.deps.repository.countCommentsForPost(post.id);
    const firstLevelCount = this.deps.repository.countFirstLevelCommentsForPost(post.id);
    return {
      id: post.id,
      workspaceId: post.workspaceId,
      authorActorId: post.authorActorId,
      authorKind: actorKindOf(actor),
      lastActivityAt: post.lastActivityAt,
      createdAt: post.createdAt,
      replyCount,
      firstLevelCount,
      status: 'active',
    };
  }

  // --- audit log read ------------------------------------------------------

  /** List the agent's own recent write actions (newest first). */
  listAudit(input: {
    principal: Principal;
    limit?: number;
  }): AgentAuditEntry[] {
    return this.deps.audit
      .listForActor(input.principal.actorId, input.limit ?? 100)
      .map((row) => ({
        id: row.id,
        action: row.action,
        targetId: row.targetId,
        rootPostId: row.rootPostId,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.createdAt,
      }));
  }

  // --- credential lifecycle (admin / self-service) ------------------------

  /** Issue a new credential for an agent. The plaintext is shown once only. */
  issueCredential(input: {
    principal: Principal;
    label?: string;
  }): { id: string; secret: string; actorId: string; workspaceId: string; label: string | null; createdAt: string } {
    assertAgent(input.principal);
    const request: { actorId: string; workspaceId: string; label?: string } = {
      actorId: input.principal.actorId,
      workspaceId: input.principal.workspaceId,
    };
    if (input.label !== undefined) request.label = input.label;
    return this.deps.credentials.issue(request);
  }

  /** Rotate the agent's active credential. Old secret is rejected thereafter. */
  rotateCredential(input: {
    principal: Principal;
    label?: string;
  }): { id: string; secret: string; actorId: string; workspaceId: string; label: string | null; createdAt: string } {
    assertAgent(input.principal);
    const request: { actorId: string; workspaceId: string; label?: string } = {
      actorId: input.principal.actorId,
      workspaceId: input.principal.workspaceId,
    };
    if (input.label !== undefined) request.label = input.label;
    return this.deps.credentials.rotate(request);
  }

  /** Revoke all active credentials for the agent in the current workspace. */
  revokeCredentials(input: { principal: Principal }): number {
    assertAgent(input.principal);
    return this.deps.credentials.revokeAllForActorInWorkspace(
      input.principal.actorId,
      input.principal.workspaceId,
    );
  }

  // --- internal: idempotency + audit + quota wrapper ----------------------

  /**
   * Run an agent write under the idempotency + audit + quota contract.
   *
   * - If an idempotency key is supplied and a record already exists for this
   *   actor + action, the current request digest is compared to the stored
   *   digest. On a match the stored target is returned as a replay (no new
   *   write, no bump, no audit, no quota consumed); the original target is
   *   re-read via `refetch` so the caller receives the current DTO shape. On a
   *   mismatch `IdempotencyKeyReuseError` is thrown — the key was reused for a
   *   different payload, so the request is rejected without a write or bump.
   * - Otherwise consume quota, perform the write via the shared C2/C3 service,
   *   store the idempotency record, and append an audit record.
   */
  private writeWithIdempotency<T>(
    action: AgentWriteAction,
    principal: Principal,
    idempotencyKey: string | undefined,
    payloadForDigest: string,
    perform: () => { target: T; targetId: string; rootPostId: string | null },
    refetch: (targetId: string) => T,
  ): AgentWriteResult<T> {
    assertAgent(principal);

    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      const existing = this.deps.idempotency.lookup(idempotencyKey, principal.actorId, action);
      if (existing !== undefined) {
        // Reject a key reused with a different payload before any replay or
        // write: the digest must match the original request exactly.
        if (existing.requestDigest !== requestDigest(payloadForDigest)) {
          throw new IdempotencyKeyReuseError(principal.actorId, idempotencyKey, action);
        }
        // Replay: re-read the original target without re-performing the write,
        // so no duplicate row and no second feed bump is triggered.
        const replayed = refetch(existing.targetId);
        return { result: replayed, replay: true, action };
      }
    }

    const { target, targetId, rootPostId } = perform();

    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.deps.idempotency.store({
        key: idempotencyKey,
        actorId: principal.actorId,
        workspaceId: principal.workspaceId,
        action,
        targetId,
        requestDigest: requestDigest(payloadForDigest),
      });
    }

    const auditInput: {
      actorId: string;
      workspaceId: string;
      action: AgentWriteAction;
      targetId: string;
      rootPostId?: string;
      idempotencyKey?: string;
    } = {
      actorId: principal.actorId,
      workspaceId: principal.workspaceId,
      action,
      targetId,
    };
    if (rootPostId !== null) auditInput.rootPostId = rootPostId;
    if (idempotencyKey !== undefined) auditInput.idempotencyKey = idempotencyKey;
    this.deps.audit.record(auditInput);

    return { result: target, replay: false };
  }


  private checkQuota(principal: Principal): void {
    this.deps.quota.checkAndConsume(
      principal.actorId,
      principal.workspaceId,
      this.quotaConfig,
    );
  }
}


/** Assert the principal is an agent. Throws if it is a human. */
export function assertAgent(principal: Principal): void {
  if (principal.kind !== 'agent') {
    throw new Error(
      `agent control plane requires an agent principal (got ${principal.kind})`,
    );
  }
}

/** Resolve the actor kind for a status entry, defaulting to 'human' if missing. */
function actorKindOf(actor: Actor | undefined): ActorKind {
  return actor?.kind ?? 'human';
}

export {
  CommentNotFoundError,
  PostNotFoundError,
};
