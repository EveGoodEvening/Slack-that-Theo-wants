import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, MiddlewareHandler } from 'hono';
import type { MembershipRepository } from './membership.js';
import type { AuthRepository } from './auth.js';
import { resolvePrincipal } from './principal.js';
import { AuthorizationError, type Principal, type Role } from './types.js';

/**
 * C9 shared authorization middleware.
 *
 * This is the single Hono middleware every protected human app/API surface
 * routes through. It resolves a Principal from a sign-in session, stores it on
 * the context as `principal`, and (optionally) enforces a minimum role for the
 * route. Per-endpoint read/write scope checks remain in the service layer via
 * `assertCanRead` / `assertCanWrite`, so resolving a session alone never grants
 * cross-workspace access.
 */

/** Hono context variables added by the authorization middleware. */
export interface AuthVariables {
  principal: Principal;
}

/**
 * Map an AuthorizationError to an HTTP response. 401 for missing/unknown
 * principal, 403 for membership/role/workspace failures. Non-authorization
 * errors are rethrown so unrelated failures are not hidden.
 */
export function authorizationErrorResponse(
  err: unknown,
): { status: ContentfulStatusCode; body: { error: string; code: string } } {
  if (err instanceof AuthorizationError) {
    return {
      status: err.status as ContentfulStatusCode,
      body: { error: err.message, code: err.code },
    };
  }
  throw err;
}

/** Shared Hono onError mapper for downstream authorization failures. */
export function authorizationErrorHandler(err: Error, c: Context): Response {
  const { status, body } = authorizationErrorResponse(err);
  return c.json(body, status);
}

/** Install the shared AuthorizationError mapper on a Hono app or route. */
export function installAuthorizationErrorHandler(app: {
  onError: (handler: (err: Error, c: Context) => Response) => unknown;
}): void {
  app.onError(authorizationErrorHandler);
}

/**
 * Authorization middleware that resolves the principal and stores it on the
 * context. Does not enforce a role; per-route handlers call assertCanRead /
 * assertCanWrite against `c.get('principal')`. Use this as the base auth
 * middleware on every protected route.
 */
export function authMiddleware(
  membership: MembershipRepository,
  auth: AuthRepository,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    let principal: Principal;
    try {
      principal = resolvePrincipal(c.req, membership, auth);
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

/**
 * Authorization middleware that also enforces a minimum role for the route.
 * Use `requireRead` on read endpoints and `requireWrite` on write endpoints as
 * a route-level baseline; handlers still call assertCanRead/assertCanWrite for
 * per-resource workspace checks.
 */
export function requireRole(
  membership: MembershipRepository,
  role: Role,
  auth: AuthRepository,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    let principal: Principal;
    try {
      principal = resolvePrincipal(c.req, membership, auth);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        const { status, body } = authorizationErrorResponse(err);
        return c.json(body, status);
      }
      throw err;
    }

    c.set('principal', principal);

    // Role baseline: a 'read' principal cannot reach a write route at all.
    if (role === 'write' && principal.role !== 'write') {
      return c.json(
        {
          error: `principal ${principal.actorId} lacks write role`,
          code: 'write_forbidden',
        },
        403,
      );
    }

    await next();
  };
}

/**
 * Helper to read the principal off a context in a handler. Throws if the
 * auth middleware did not run (programming error, not a client error).
 */
export function getPrincipal(c: Context<{ Variables: AuthVariables }>): Principal {
  const principal = c.get('principal');
  if (!principal) {
    throw new Error('auth middleware did not set principal on context');
  }
  return principal;
}
