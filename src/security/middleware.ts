import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context, MiddlewareHandler } from 'hono';
import type { MembershipRepository } from './membership.js';
import { resolvePrincipal } from './principal.js';
import { AuthorizationError, type Principal, type Role } from './types.js';

/**
 * C1a shared authorization middleware.
 *
 * This is the single Hono middleware every later exposed surface (C2/C3/C7/C8)
 * routes through. It resolves a Principal from the request via the stubbed
 * principal resolver, stores it on the context as `principal`, and (optionally)
 * enforces a minimum role for the route. Per-endpoint read/write scope checks
 * are then performed against the stored principal using the helpers in
 * `authorization.ts` (assertCanRead / assertCanWrite / filterByScope).
 *
 * C9 replaces the stubbed `resolvePrincipal` with real sign-in; this middleware
 * and the `principal` context variable persist.
 */

/** Hono context variables added by the authorization middleware. */
export interface AuthVariables {
  principal: Principal;
}

/**
 * Map an AuthorizationError to an HTTP response. 401 for missing/unknown
 * principal, 403 for membership/role/workspace failures. Any other thrown error
 * surfaces as a 500 so authorization logic bugs are not silently swallowed.
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
  return {
    status: 500,
    body: { error: 'internal authorization error', code: 'internal' },
  };
}

/**
 * Authorization middleware that resolves the principal and stores it on the
 * context. Does not enforce a role; per-route handlers call assertCanRead /
 * assertCanWrite against `c.get('principal')`. Use this as the base auth
 * middleware on every protected route.
 */
export function authMiddleware(
  membership: MembershipRepository,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    let principal: Principal;
    try {
      principal = resolvePrincipal(c.req, membership);
    } catch (err) {
      const { status, body } = authorizationErrorResponse(err);
      return c.json(body, status);
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
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    let principal: Principal;
    try {
      principal = resolvePrincipal(c.req, membership);
    } catch (err) {
      const { status, body } = authorizationErrorResponse(err);
      return c.json(body, status);
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
