import { type Context, Hono } from 'hono';
import type { BetterSqliteDatabase } from '../db/connection.js';
import type { DomainRepository } from '../domain/repositories.js';
import {
  AgentAuditRepository,
  AgentCredentialRepository,
  AgentIdempotencyRepository,
  AgentProfileRepository,
  AgentQuotaRepository,
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_SCHEME,
  authorizationErrorResponse,
  AuthorizationError,
  IdempotencyKeyReuseError,
  type MembershipRepository,
  QuotaExceededError,
  resolveAgentPrincipal,
  type Principal,
} from '../security/index.js';
import {
  CommentNotFoundError,
  CommentServiceImpl,
  DeletedParentError,
  PostNotFoundError,
  type CommentService,
} from './commentService.js';
import {
  AgentService,
  IDEMPOTENCY_HEADER,
  type AgentStatusPage,
  type AgentWriteResult,
  type PostStatusEntry,
} from './agentService.js';
import type { ActivityEventPublisher } from './activityEvents.js';
import { decodeCursor, PostServiceImpl, type FeedCursor, type PostService } from './postService.js';

/**
 * C7 agent control-plane HTTP surface.
 *
 * Mounts the agent API under /agents, all routed through the C1a authorization
 * middleware using agent credential (Bearer token) principal resolution. Agent
 * write endpoints reuse the C2/C3 services and layer idempotency, audit
 * logging, and rate-limit/quota on top. Read endpoints expose the
 * machine-readable feed and priority/status metadata contract, least-privilege
 * scoped to the caller's workspace.
 *
 * - POST /agents/posts                       create a post (idempotency required)
 * - POST /agents/posts/:postId/comments      create a first-level comment (idempotency required)
 * - POST /agents/comments/:parentId/replies  create a reply (idempotency required)
 * - GET  /agents/feed                        machine-readable feed (workspace-scoped)
 * - GET  /agents/status                      priority/status metadata (activity-ordered)
 * - GET  /agents/status/:postId              single-post status metadata
 * - GET  /agents/posts/:postId               read a post + comment metadata
 * - GET  /agents/comments/:id/subtree        fetch a subtree
 * - GET  /agents/posts/:postId/thread        fetch the full thread
 * - GET  /agents/audit                       the agent's own recent write actions
 * - POST /agents/credentials                 issue a new credential (one-time secret)
 * - POST /agents/credentials/rotate          rotate (new secret, old revoked)
 * - POST /agents/credentials/revoke          revoke all active credentials
 *
 * Credential issuance/rotation return the plaintext secret exactly once.
 */

/** Agent route dependencies. */
export interface AgentRouteDeps {
  repository: DomainRepository;
  membership: MembershipRepository;
  /** The underlying database connection for C7 security repositories. */
  db: BetterSqliteDatabase;
  /** Optional service override; defaults to AgentService over C2/C3 services. */
  service?: AgentService;
  /** Optional shared C8 publisher; supplied by createApp so agent writes emit on the same hub. */
  activity?: ActivityEventPublisher;
  /** Optional shared post service; lets C7 publish through the same C8 path. */
  postService?: PostService;
  /** Optional shared comment service; lets C7 publish through the same C8 path. */
  commentService?: CommentService;
}

/** Context variables for the agent surface: the resolved agent principal. */
export interface AgentAuthVariables {
  principal: Principal;
}

export function agentRoutes(deps: AgentRouteDeps): Hono<{
  Variables: AgentAuthVariables;
}> {
  const route = new Hono<{ Variables: AgentAuthVariables }>();
  const credentials = new AgentCredentialRepository(deps.db);
  const postService = deps.postService ?? new PostServiceImpl(deps.repository, deps.activity);
  const commentService =
    deps.commentService ?? new CommentServiceImpl(deps.repository, deps.activity);
  // The AgentService is constructed with all C7 repositories. When a service
  // override is supplied (tests), use it directly.
  const service =
    deps.service ??
    new AgentService({
      repository: deps.repository,
      postService,
      commentService,
      credentials,
      profiles: new AgentProfileRepository(deps.db),
      audit: new AgentAuditRepository(deps.db),
      idempotency: new AgentIdempotencyRepository(deps.db),
      quota: new AgentQuotaRepository(deps.db),
    });

  // Resolve the agent principal from the Bearer token on every route.
  route.use('*', agentAuthMiddleware(deps.membership, credentials));

  // --- agent writes --------------------------------------------------------

  route.post('/posts', async (c) => {
    const principal = c.get('principal');
    const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER);
    if (!isPresentIdempotencyKey(idempotencyKey)) {
      return missingIdempotencyKey(c);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { content?: unknown }
      | null;
    if (body === null) {
      return c.json({ error: 'request body must be JSON', code: 'bad_request' }, 400);
    }
    if (typeof body.content !== 'string' || body.content.length === 0) {
      return c.json(
        { error: 'content must be a non-empty string', code: 'bad_request' },
        400,
      );
    }
    try {
      const result = service.createPost({ principal, content: body.content, idempotencyKey });
      return c.json(writeResultBody(result), result.replay ? 200 : 201);
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.post('/posts/:postId/comments', async (c) => {
    const principal = c.get('principal');
    const postId = c.req.param('postId');
    const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER);
    if (!isPresentIdempotencyKey(idempotencyKey)) {
      return missingIdempotencyKey(c);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { content?: unknown }
      | null;
    if (body === null) {
      return c.json({ error: 'request body must be JSON', code: 'bad_request' }, 400);
    }
    if (typeof body.content !== 'string' || body.content.length === 0) {
      return c.json(
        { error: 'content must be a non-empty string', code: 'bad_request' },
        400,
      );
    }
    try {
      const result = service.createComment({
        principal,
        postId,
        content: body.content,
        idempotencyKey,
      });
      return c.json(writeResultBody(result), result.replay ? 200 : 201);
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.post('/comments/:parentId/replies', async (c) => {
    const principal = c.get('principal');
    const parentId = c.req.param('parentId');
    const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER);
    if (!isPresentIdempotencyKey(idempotencyKey)) {
      return missingIdempotencyKey(c);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { content?: unknown }
      | null;
    if (body === null) {
      return c.json({ error: 'request body must be JSON', code: 'bad_request' }, 400);
    }
    if (typeof body.content !== 'string' || body.content.length === 0) {
      return c.json(
        { error: 'content must be a non-empty string', code: 'bad_request' },
        400,
      );
    }
    try {
      const result = service.createReply({
        principal,
        parentId,
        content: body.content,
        idempotencyKey,
      });
      return c.json(writeResultBody(result), result.replay ? 200 : 201);
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  // --- agent reads: feed + status metadata --------------------------------

  route.get('/feed', (c) => {
    const principal = c.get('principal');
    const cursor = parseCursor(c);
    if (cursor === null) {
      return c.json({ error: 'malformed cursor', code: 'bad_request' }, 400);
    }
    const page = service.listFeed(pagedInput(principal, c, cursor));
    return c.json({ posts: page.posts, nextCursor: page.nextCursor });
  });

  route.get('/status', (c) => {
    const principal = c.get('principal');
    const cursor = parseCursor(c);
    if (cursor === null) {
      return c.json({ error: 'malformed cursor', code: 'bad_request' }, 400);
    }
    const page: AgentStatusPage = service.listStatus(pagedInput(principal, c, cursor));
    return c.json({ posts: page.posts, nextCursor: page.nextCursor });
  });

  route.get('/status/:postId', (c) => {
    const principal = c.get('principal');
    const postId = c.req.param('postId');
    try {
      const entry: PostStatusEntry = service.readStatus({ principal, postId });
      return c.json(entry);
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.get('/posts/:postId', (c) => {
    const principal = c.get('principal');
    const postId = c.req.param('postId');
    try {
      return c.json(service.readPost({ principal, postId }));
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.get('/comments/:id/subtree', (c) => {
    const principal = c.get('principal');
    const id = c.req.param('id');
    try {
      return c.json(service.getSubtree({ principal, commentId: id }));
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.get('/posts/:postId/thread', (c) => {
    const principal = c.get('principal');
    const postId = c.req.param('postId');
    try {
      return c.json(service.getFullThread({ principal, postId }));
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  // --- agent audit log -----------------------------------------------------

  route.get('/audit', (c) => {
    const principal = c.get('principal');
    const limit = parseLimit(c);
    const input: { principal: Principal; limit?: number } = { principal };
    if (limit !== undefined) input.limit = limit;
    return c.json({ actions: service.listAudit(input) });
  });

  // --- credential lifecycle ------------------------------------------------

  route.post('/credentials', async (c) => {
    const principal = c.get('principal');
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    const label = typeof body.label === 'string' ? body.label : undefined;
    try {
      const issued = service.issueCredential(labelledInput(principal, label));
      // One-time secret display: the plaintext is never retrievable again.
      return c.json(issued, 201);
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.post('/credentials/rotate', async (c) => {
    const principal = c.get('principal');
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    const label = typeof body.label === 'string' ? body.label : undefined;
    try {
      const issued = service.rotateCredential(labelledInput(principal, label));
      return c.json(issued, 201);
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  route.post('/credentials/revoke', (c) => {
    const principal = c.get('principal');
    try {
      const count = service.revokeCredentials({ principal });
      return c.json({ revoked: count });
    } catch (err) {
      return mapAgentError(c, err);
    }
  });

  return route;
}

// ---------------------------------------------------------------------------
// Agent auth middleware: Bearer token → agent Principal
// ---------------------------------------------------------------------------

/**
 * Resolve the agent principal from the Authorization Bearer header and store
 * it on the context. Maps AuthorizationError to 401/403 via the shared C1a
 * error response mapper.
 */
function agentAuthMiddleware(
  membership: MembershipRepository,
  credentials: AgentCredentialRepository,
) {
  return async (c: Context<{ Variables: AgentAuthVariables }>, next: () => Promise<void>) => {
    let principal: Principal;
    try {
      principal = resolveAgentPrincipal(c.req, credentials, membership);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        const { status, body } = authorizationErrorResponse(err);
        return c.json(body, status);
      }
      throw err;
    }
    c.set('principal', principal);
    await next();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the JSON body for an agent write result, flagging replays. */
function writeResultBody<T>(result: AgentWriteResult<T>): { result: T; replay: boolean; action?: string } {
  if (result.replay) {
    return { result: result.result, replay: true, action: result.action };
  }
  return { result: result.result, replay: false };
}

/** Parse the limit query param, clamped to a positive integer or undefined. */
function parseLimit(c: Context): number | undefined {
  const raw = c.req.query('limit');
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** Parse the cursor query param. Returns null on malformed, undefined when absent. */
function parseCursor(c: Context): FeedCursor | null | undefined {
  const raw = c.req.query('cursor');
  if (raw === undefined || raw === '') return undefined;
  try {
    return decodeCursor(raw);
  } catch {
    return null;
  }
}

function pagedInput(
  principal: Principal,
  c: Context,
  cursor: FeedCursor | undefined,
): { principal: Principal; cursor?: FeedCursor; limit?: number } {
  const input: { principal: Principal; cursor?: FeedCursor; limit?: number } = {
    principal,
  };
  if (cursor !== undefined) input.cursor = cursor;
  const limit = parseLimit(c);
  if (limit !== undefined) input.limit = limit;
  return input;
}

function labelledInput(
  principal: Principal,
  label: string | undefined,
): { principal: Principal; label?: string } {
  if (label === undefined) return { principal };
  return { principal, label };
}

function isPresentIdempotencyKey(key: string | undefined): key is string {
  return key !== undefined && key.trim().length > 0;
}

function missingIdempotencyKey(c: Context): Response {
  return c.json(
    {
      error: `${IDEMPOTENCY_HEADER} header is required for agent writes`,
      code: 'missing_idempotency_key',
    },
    400,
  );
}

/** Map service-layer errors to HTTP responses. */
function mapAgentError(c: Context, err: unknown): Response {
  if (err instanceof QuotaExceededError) {
    return c.json(
      { error: err.message, code: 'quota_exceeded', limit: err.limit },
      429,
    );
  }
  if (err instanceof IdempotencyKeyReuseError) {
    return c.json(
      { error: err.message, code: 'idempotency_key_reuse' },
      422,
    );
  }
  if (err instanceof DeletedParentError) {
    return c.json({ error: err.message, code: 'deleted_parent' }, 409);
  }
  if (err instanceof PostNotFoundError || errorName(err) === 'PostNotFoundError') {
    // Generic not-found: the post id and any workspace context must not leak,
    // so a guessed cross-workspace id is indistinguishable from an absent id.
    return c.json({ error: 'not found', code: 'not_found' }, 404);
  }
  if (err instanceof CommentNotFoundError) {
    // Generic not-found: the comment id and any workspace context must not
    // leak, so a guessed cross-workspace id is indistinguishable from an
    // absent id. Same shape/status as the PostNotFoundError and
    // workspace_mismatch redaction paths above and below.
    return c.json({ error: 'not found', code: 'not_found' }, 404);
  }
  // Cross-workspace resource access (read/status/comment metadata) must not
  // leak the target workspace's existence: translate workspace_mismatch into a
  // generic not-found response with no workspace identifier.
  if (err instanceof AuthorizationError && err.code === 'workspace_mismatch') {
    return c.json({ error: 'not found', code: 'not_found' }, 404);
  }
  if (err instanceof AuthorizationError) {
    const { status, body } = authorizationErrorResponse(err);
    return c.json(body, status);
  }
  throw err;
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

export { AGENT_TOKEN_HEADER, AGENT_TOKEN_SCHEME };
