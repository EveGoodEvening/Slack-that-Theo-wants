import { type Context, Hono } from 'hono';
import type { DomainRepository } from '../domain/repositories.js';
import type { MembershipRepository } from '../security/membership.js';
import {
  installAuthorizationErrorHandler,
  requireRole,
  type AuthVariables,
} from '../security/index.js';
import {
  CommentNotFoundError,
  CommentServiceImpl,
  DeletedParentError,
  PostNotFoundError,
  type CommentService,
} from './commentService.js';

/**
 * C3 comment/reply HTTP surface.
 *
 * Mounts four endpoints under /posts/:postId/comments and /comments. Each
 * endpoint installs the shared C1a role middleware directly:
 * - POST   /posts/:postId/comments          create a first-level comment (write)
 * - POST   /comments/:parentId/replies      create a reply to any comment (write)
 * - GET    /comments/:id/subtree            fetch a subtree rooted at a comment (read)
 * - GET    /posts/:postId/thread            fetch the full thread under a post (read)
 *
 * Every endpoint resolves the principal via the C1a middleware and delegates to
 * the CommentService, which enforces the workspace/group boundary before any
 * read/write and reuses the C1 shared bump helper for every insert.
 * AuthorizationError is mapped by the shared C1a error handler; domain
 * not-found / deleted-parent errors are mapped here.
 */

export interface CommentRouteDeps {
  repository: DomainRepository;
  membership: MembershipRepository;
  /** Optional service override; defaults to CommentServiceImpl over the repo. */
  service?: CommentService;
}

export function commentRoutes(deps: CommentRouteDeps): Hono<{
  Variables: AuthVariables;
}> {
  const route = new Hono<{ Variables: AuthVariables }>();
  installAuthorizationErrorHandler(route);

  const service = deps.service ?? new CommentServiceImpl(deps.repository);

  // Route-level role middleware below resolves/stores the principal for the
  // comment API paths only. Do not install a root wildcard middleware here: this
  // sub-app is mounted at '/', and a wildcard would also intercept human UI
  // routes such as /feed before they can render their HTML error states.
  // Create first-level comment — write role baseline.
  route.post(
    '/posts/:postId/comments',
    requireRole(deps.membership, 'write'),
    async (c) => {
      const principal = c.get('principal');
      const postId = c.req.param('postId');
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
        const comment = service.createComment({
          principal,
          postId,
          content: body.content,
        });
        return c.json(comment, 201);
      } catch (err) {
        return mapDomainError(c, err);
      }
    },
  );

  // Create reply to any comment/reply — write role baseline.
  route.post(
    '/comments/:parentId/replies',
    requireRole(deps.membership, 'write'),
    async (c) => {
      const principal = c.get('principal');
      const parentId = c.req.param('parentId');
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
        const reply = service.createReply({
          principal,
          parentId,
          content: body.content,
        });
        return c.json(reply, 201);
      } catch (err) {
        return mapDomainError(c, err);
      }
    },
  );

  // Fetch subtree rooted at a comment — read role baseline.
  route.get(
    '/comments/:id/subtree',
    requireRole(deps.membership, 'read'),
    (c) => {
      const principal = c.get('principal');
      const id = c.req.param('id');
      try {
        const result = service.getSubtree({ principal, commentId: id });
        return c.json(result);
      } catch (err) {
        return mapDomainError(c, err);
      }
    },
  );

  // Fetch full thread under a post — read role baseline.
  route.get(
    '/posts/:postId/thread',
    requireRole(deps.membership, 'read'),
    (c) => {
      const principal = c.get('principal');
      const postId = c.req.param('postId');
      try {
        const result = service.getFullThread({ principal, postId });
        return c.json(result);
      } catch (err) {
        return mapDomainError(c, err);
      }
    },
  );

  return route;
}

/**
 * Map service-layer domain errors to HTTP responses. AuthorizationError is
 * handled by the shared C1a error handler installed above; this maps the C3
 * not-found and deleted-parent errors. Unknown errors rethrow to surface as 500.
 */
function mapDomainError(c: Context, err: unknown): Response {
  if (err instanceof CommentNotFoundError) {
    return c.json({ error: err.message, code: 'not_found' }, 404);
  }
  if (err instanceof PostNotFoundError) {
    return c.json({ error: err.message, code: 'not_found' }, 404);
  }
  if (err instanceof DeletedParentError) {
    return c.json({ error: err.message, code: 'deleted_parent' }, 409);
  }
  throw err;
}
