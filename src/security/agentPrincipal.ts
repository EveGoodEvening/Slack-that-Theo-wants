import type { MembershipRepository, ResolvedMembership } from './membership.js';
import { membershipToPrincipal } from './principal.js';
import { AuthorizationError, type Principal } from './types.js';
import type { AgentCredentialRepository } from './credentials.js';

/**
 * C7 agent principal resolution.
 *
 * Resolves an agent Principal from a request carrying an agent API token in
 * the `Authorization: Bearer <secret>` header. The secret is verified against
 * the hashed `agent_credential` table; the resolved actor must be an agent
 * member of the credential's workspace. This is the agent-side counterpart to
 * the C1a stubbed `resolvePrincipal` (header-based) — both produce the same
 * `Principal` shape so the shared C1a authorization middleware and per-
 * resource checks apply unchanged to agent callers.
 *
 * C9 replaces the credential verification with real sign-in-backed tokens
 * while keeping the Principal shape and the middleware that consume it.
 */

/** The header carrying an agent API token. */
export const AGENT_TOKEN_HEADER = 'authorization';

/** The token scheme prefix expected in the Authorization header. */
export const AGENT_TOKEN_SCHEME = 'Bearer';

/** The minimal request surface the resolver depends on. */
export interface AgentPrincipalRequest {
  header(name: string): string | undefined;
}

/**
 * Resolve an agent Principal from a Bearer token. Throws AuthorizationError on
 * any failure (missing/unknown/revoked credential, non-agent actor, non-
 * member). Returns the Principal on success.
 */
export function resolveAgentPrincipal(
  request: AgentPrincipalRequest,
  credentials: AgentCredentialRepository,
  membership: MembershipRepository,
): Principal {
  const header = request.header(AGENT_TOKEN_HEADER);
  if (header === undefined) {
    throw new AuthorizationError(
      'missing_principal',
      'missing agent credential (Authorization: Bearer <secret>)',
      401,
    );
  }
  const trimmed = header.trim();
  const scheme = `${AGENT_TOKEN_SCHEME} `;
  if (!trimmed.startsWith(scheme)) {
    throw new AuthorizationError(
      'missing_principal',
      `agent credential must use ${AGENT_TOKEN_SCHEME} scheme`,
      401,
    );
  }
  const secret = trimmed.slice(scheme.length).trim();
  if (secret.length === 0) {
    throw new AuthorizationError(
      'missing_principal',
      'agent credential secret is empty',
      401,
    );
  }

  const verified = credentials.verify(secret);
  if (verified === undefined) {
    throw new AuthorizationError(
      'principal_not_found',
      'agent credential is unknown or revoked',
      401,
    );
  }

  const resolved = membership.resolveMembership(
    verified.workspaceId,
    verified.actorId,
  );
  if (resolved === undefined) {
    throw new AuthorizationError(
      'principal_not_found',
      `agent ${verified.actorId} is not a member of workspace ${verified.workspaceId}`,
      401,
    );
  }
  if (resolved.kind !== 'agent') {
    // A credential must belong to an agent actor. Non-agent actors cannot use
    // the agent control plane even if a credential row somehow matched.
    throw new AuthorizationError(
      'principal_not_found',
      `actor ${verified.actorId} is not an agent`,
      401,
    );
  }
  return membershipToPrincipal(resolved as ResolvedMembership);
}
