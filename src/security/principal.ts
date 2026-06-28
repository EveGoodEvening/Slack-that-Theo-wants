import {
  type AuthRepository,
  sessionSecretFromRequest,
  type SessionPrincipalRequest,
} from './auth.js';
import { AuthorizationError, type Principal } from './types.js';
import type { MembershipRepository, ResolvedMembership } from './membership.js';

/**
 * C9 sign-in-backed principal resolution.
 *
 * Normal app/API requests resolve a Principal from an opaque session created by
 * the local sign-in flow. Browser requests carry the session in the
 * HttpOnly `sttw_session` cookie; API clients may send the same session secret
 * as `Authorization: Bearer <session>`. Stubbed x-actor-id/x-workspace-id
 * headers are intentionally no longer accepted on protected paths.
 */

/** The minimal request surface the resolver depends on. */
export interface PrincipalRequest extends SessionPrincipalRequest {}

/**
 * Resolve a Principal from a sign-in session. Throws AuthorizationError on any
 * failure so the shared middleware maps missing/expired sessions to 401 and
 * inactive memberships to 401/403 without leaking content.
 */
export function resolvePrincipal(
  request: PrincipalRequest,
  membership: MembershipRepository,
  auth: AuthRepository,
): Principal {
  const secret = sessionSecretFromRequest(request);
  if (secret === undefined) {
    throw new AuthorizationError(
      'missing_principal',
      'missing sign-in session',
      401,
    );
  }

  const session = auth.resolveSession(secret);
  if (session === undefined) {
    throw new AuthorizationError(
      'principal_not_found',
      'sign-in session is unknown, expired, or revoked',
      401,
    );
  }

  const resolved = membership.resolveMembership(session.workspaceId, session.actorId);
  if (resolved === undefined) {
    throw new AuthorizationError(
      'principal_not_found',
      `actor ${session.actorId} is not an active member of workspace ${session.workspaceId}`,
      401,
    );
  }

  return membershipToPrincipal(resolved);
}

/**
 * Build a Principal from a resolved membership. Exported so tests, auth, and
 * agent credential resolution can construct principals without duplicating the
 * shape.
 */
export function membershipToPrincipal(m: ResolvedMembership): Principal {
  return {
    actorId: m.actorId,
    workspaceId: m.workspaceId,
    kind: m.kind,
    role: m.role,
  };
}
