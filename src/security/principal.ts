import { AuthorizationError, type Principal } from './types.js';
import type { MembershipRepository, ResolvedMembership } from './membership.js';

/**
 * C1a stubbed principal resolution.
 *
 * Maps a request to a Principal (actor + workspace + kind + role) using
 * stubbed auth headers. This is the ONLY place that knows how to extract an
 * identity from a request in C1a; C9 replaces this with real sign-in (session
 * cookies / tokens) while keeping the Principal shape and the middleware that
 * consume it.
 *
 * Stubbed header contract (C1a only — replaced by C9):
 * - `x-actor-id`:     the actor id (human or agent)
 * - `x-workspace-id`: the workspace/group the actor is acting in
 *
 * The resolver validates the (workspace, actor) pair against the membership
 * table. A missing header, unknown actor, or non-member yields an
 * AuthorizationError so the middleware can map it to a 401/403.
 */

/**
 * The minimal request surface the resolver depends on. Hono's `c.req` satisfies
 * this (`request.header(name)`), and tests can pass a plain object. Keeping the
 * dependency narrow means C9 can swap the extraction without touching the
 * membership-validation core.
 */
export interface PrincipalRequest {
  header(name: string): string | undefined;
}

/** Header names for the C1a stubbed auth contract. */
export const PRINCIPAL_HEADERS = {
  actorId: 'x-actor-id',
  workspaceId: 'x-workspace-id',
} as const;

/**
 * Resolve a Principal from a request using the stubbed auth headers and the
 * membership repository. Throws AuthorizationError on any failure.
 */
export function resolvePrincipal(
  request: PrincipalRequest,
  membership: MembershipRepository,
): Principal {
  const actorId = request.header(PRINCIPAL_HEADERS.actorId);
  const workspaceId = request.header(PRINCIPAL_HEADERS.workspaceId);

  if (!actorId || !workspaceId) {
    throw new AuthorizationError(
      'missing_principal',
      'missing principal credentials (x-actor-id / x-workspace-id)',
      401,
    );
  }

  const resolved = membership.resolveMembership(workspaceId, actorId);
  if (resolved === undefined) {
    // Unknown actor or not a member of the workspace.
    throw new AuthorizationError(
      'principal_not_found',
      `actor ${actorId} is not a member of workspace ${workspaceId}`,
      401,
    );
  }

  return membershipToPrincipal(resolved);
}

/**
 * Build a Principal from a resolved membership. Exported so tests and C9 can
 * construct principals directly without going through the request stub.
 */
export function membershipToPrincipal(m: ResolvedMembership): Principal {
  return {
    actorId: m.actorId,
    workspaceId: m.workspaceId,
    kind: m.kind,
    role: m.role,
  };
}
