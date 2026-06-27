import type { MembershipRepository } from '../security/membership.js';
import {
  membershipToPrincipal,
  PRINCIPAL_HEADERS,
} from '../security/principal.js';
import { AuthorizationError, type Principal } from '../security/types.js';

/**
 * C4/C5 shared UI helpers.
 *
 * The human UI routes (C4 feed, C5 post detail) share one principal-resolution
 * path and one static-text escaper. Centralizing them here keeps the C1a
 * membership-validation core the single source of identity for browser UI and
 * prevents a second escaping convention from appearing beside the C4 one.
 *
 * Principal resolution reuses the C1a `membership.resolveMembership` +
 * `membershipToPrincipal` core. Credentials are read from request headers first
 * (API clients), then browser `actorId` / `workspaceId` query parameters on GET
 * and form fields on POST. The pair is always validated against the membership
 * table; C9 swaps the extraction, not the validation.
 */

/** Browser query/form credential field names plus C1a header fallback names. */
export const ACTOR_FIELD = 'actorId';
export const WORKSPACE_FIELD = 'workspaceId';
export const ACTOR_HEADER_FIELD = PRINCIPAL_HEADERS.actorId;
export const WORKSPACE_HEADER_FIELD = PRINCIPAL_HEADERS.workspaceId;

/**
 * Resolve a principal from a Hono request using the C1a membership core.
 * Headers take precedence (API clients), then browser/header-named query params,
 * then browser/header-named form fields. Throws AuthorizationError on failure.
 */
export function resolveUiPrincipal(
  req: {
    header(name: string): string | undefined;
    query(name: string): string | undefined;
  },
  bodyParams: Record<string, string | undefined>,
  membership: MembershipRepository,
): Principal {
  const actorId =
    req.header(ACTOR_HEADER_FIELD) ??
    req.query(ACTOR_HEADER_FIELD) ??
    req.query(ACTOR_FIELD) ??
    bodyParams[ACTOR_FIELD] ??
    bodyParams[ACTOR_HEADER_FIELD];
  const workspaceId =
    req.header(WORKSPACE_HEADER_FIELD) ??
    req.query(WORKSPACE_HEADER_FIELD) ??
    req.query(WORKSPACE_FIELD) ??
    bodyParams[WORKSPACE_FIELD] ??
    bodyParams[WORKSPACE_HEADER_FIELD];

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

/** Read a FormData entry as a string, returning undefined for non-strings. */
export function formField(
  form: FormData | null,
  name: string,
): string | undefined {
  const value = form?.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** HTML-escape the five significant characters for static template text. */
export function escapeText(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
