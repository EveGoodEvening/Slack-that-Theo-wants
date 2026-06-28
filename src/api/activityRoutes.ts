import { Hono } from 'hono';
import type { MembershipRepository } from '../security/membership.js';
import type { AuthRepository } from '../security/auth.js';
import {
  assertCanRead,
  authorizationErrorResponse,
  AuthorizationError,
  resolvePrincipal,
  type AuthVariables,
  type Principal,
} from '../security/index.js';
import {
  serializeActivitySse,
  type ActivityEventSource,
} from './activityEvents.js';

const ACTIVITY_STREAM_HIGH_WATER_MARK = 16;

/** C8 SSE route dependencies. */
export interface ActivityRouteDeps {
  membership: MembershipRepository;
  auth: AuthRepository;
  events: ActivityEventSource;
}

/**
 * C8 realtime subscription surface.
 *
 * GET /events streams versioned server-sent events. C9 uses the same
 * sign-in-backed session resolver as the human API/UI routes; browser
 * EventSource requests carry the HttpOnly session cookie automatically.
 */
export function activityRoutes(deps: ActivityRouteDeps): Hono<{
  Variables: AuthVariables;
}> {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get('/', (c) => {
    let principal: Principal;
    try {
      principal = resolvePrincipal(c.req, deps.membership, deps.auth);
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
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const write = (chunk: string): void => {
            if (controller.desiredSize === null || controller.desiredSize <= 0) {
              // Activity events are hints; drop instead of accumulating
              // unbounded per-subscriber memory for a slow client.
              return;
            }
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
      },
      {
        highWaterMark: ACTIVITY_STREAM_HIGH_WATER_MARK,
        size: () => 1,
      },
    );

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

