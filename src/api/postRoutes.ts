import { Hono } from 'hono';
import type { DomainRepository } from '../domain/repositories.js';
import type { MembershipRepository } from '../security/membership.js';
import type { AuthRepository } from '../security/auth.js';
import {
  authMiddleware,
  installAuthorizationErrorHandler,
  requireRole,
  type AuthVariables,
} from '../security/index.js';
import {
  decodeCursor,
  PostNotFoundError,
  PostServiceImpl,
  type FeedCursor,
  type PostService,
} from './postService.js';

/**
 * C2 post feed HTTP surface.
 *
 * Mounts three endpoints under /posts, all routed through the C9 shared
 * authorization middleware:
 * - POST   /posts        create a post (write role)
 * - GET    /posts        list the feed (read role), cursor-paginated
 * - GET    /posts/:id    read a post + comment-tree metadata (read role)
 *
 * Every endpoint resolves the principal from a sign-in session and delegates
 * to the PostService, which enforces the workspace/group boundary before any
 * ordering/pagination/metadata read. AuthorizationError is mapped by the shared
 * C1a error handler; PostNotFoundError is mapped here to a 404.
 */

export interface PostRouteDeps {
  repository: DomainRepository;
  membership: MembershipRepository;
  auth: AuthRepository;
  service?: PostService;
}

export function postRoutes(deps: PostRouteDeps): Hono<{
  Variables: AuthVariables;
}> {
  const route = new Hono<{ Variables: AuthVariables }>();
  installAuthorizationErrorHandler(route);

  const service = deps.service ?? new PostServiceImpl(deps.repository);

  // Base auth on every route: resolves + stores the session-backed principal.
  route.use('*', authMiddleware(deps.membership, deps.auth));

  // Create post — write role baseline.
  route.post('/', requireRole(deps.membership, 'write', deps.auth), async (c) => {
    const principal = c.get('principal');
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
    const post = service.createPost({ principal, content: body.content });
    return c.json(post, 201);
  });

  // List feed — read role baseline.
  route.get('/', requireRole(deps.membership, 'read', deps.auth), (c) => {
    const principal = c.get('principal');
    const limitParam = c.req.query('limit');
    const cursorRaw = c.req.query('cursor');
    let cursor: FeedCursor | undefined;
    try {
      cursor = decodeCursor(cursorRaw);
    } catch {
      return c.json({ error: 'malformed cursor', code: 'bad_request' }, 400);
    }
    const feedInput: {
      principal: typeof principal;
      limit?: number;
      cursor?: FeedCursor;
    } = {
      principal,
    };
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return c.json(
          { error: 'limit must be a positive integer', code: 'bad_request' },
          400,
        );
      }
      feedInput.limit = parsed;
    }
    if (cursor !== undefined) {
      feedInput.cursor = cursor;
    }
    const page = service.listFeed(feedInput);
    return c.json({
      posts: page.posts,
      nextCursor: page.nextCursor,
    });
  });

  // Read post — read role baseline.
  route.get('/:id', requireRole(deps.membership, 'read', deps.auth), (c) => {
    const principal = c.get('principal');
    const id = c.req.param('id');
    try {
      const result = service.readPost({ principal, postId: id });
      return c.json(result);
    } catch (err) {
      if (err instanceof PostNotFoundError) {
        return c.json({ error: err.message, code: 'not_found' }, 404);
      }
      throw err;
    }
  });

  return route;
}
