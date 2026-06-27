import { Hono } from 'hono';
import type { MembershipRepository } from '../security/membership.js';
import {
  assertCanRead,
  authorizationErrorResponse,
  AuthorizationError,
  membershipToPrincipal,
  PRINCIPAL_HEADERS,
  type AuthVariables,
  type Principal,
} from '../security/index.js';
import {
  serializeActivitySse,
  type ActivityEventSource,
} from './activityEvents.js';

/** C8 SSE route dependencies. */
export interface ActivityRouteDeps {
  membership: MembershipRepository;
  events: ActivityEventSource;
}

/**
 * C8 realtime subscription surface.
 *
 * GET /events streams versioned server-sent events. Header credentials use the
 * same C1a names as API callers; browser EventSource callers may pass the same
 * values as query params because EventSource cannot set custom headers.
 */
export function activityRoutes(deps: ActivityRouteDeps): Hono<{
  Variables: AuthVariables;
}> {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get('/', (c) => {
    let principal: Principal;
    try {
      principal = resolveRealtimePrincipal(c.req, deps.membership);
      assertCanRead(principal, principal.workspaceId);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        const { status, body } = authorizationErrorResponse(err);
        return c.json(body, status);
      }
      throw err;
    }
    c.set('principal', principal);

    const encoder = new TextEncoder();
    let unsubscribe = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string): void => {
          controller.enqueue(encoder.encode(chunk));
        };
        write(': c8-connected\n\n');
        unsubscribe = deps.events.subscribe(principal, (event) => {
          write(serializeActivitySse(event));
        });
      },
      cancel() {
        unsubscribe();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  return route;
}

function resolveRealtimePrincipal(
  req: {
    header(name: string): string | undefined;
    query(name: string): string | undefined;
  },
  membership: MembershipRepository,
): Principal {
  const actorId =
    req.header(PRINCIPAL_HEADERS.actorId) ??
    req.query(PRINCIPAL_HEADERS.actorId) ??
    req.query('actorId');
  const workspaceId =
    req.header(PRINCIPAL_HEADERS.workspaceId) ??
    req.query(PRINCIPAL_HEADERS.workspaceId) ??
    req.query('workspaceId');

  if (!actorId || !workspaceId) {
    throw new AuthorizationError(
      'missing_principal',
      'missing principal credentials (x-actor-id / x-workspace-id or actorId / workspaceId)',
      401,
    );
  }

  const resolved = membership.resolveMembership(workspaceId, actorId);
  if (resolved === undefined) {
    throw new AuthorizationError(
      'principal_not_found',
      `actor ${actorId} is not a member of workspace ${workspaceId}`,
      401,
    );
  }
  return membershipToPrincipal(resolved);
}
