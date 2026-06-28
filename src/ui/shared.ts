import type { AuthRepository } from '../security/auth.js';
import type { MembershipRepository } from '../security/membership.js';
import { resolvePrincipal } from '../security/principal.js';
import { AuthorizationError, type Principal } from '../security/types.js';

/**
 * C4/C5 shared UI helpers.
 *
 * Human UI routes resolve identity through the same C9 sign-in session path as
 * the JSON APIs. Browser forms no longer carry actor/workspace hidden fields;
 * the HttpOnly session cookie selects the current workspace/group, and all
 * service methods still enforce per-resource read/write scope.
 */

/** Resolve a principal from the request's sign-in session. */
export function resolveUiPrincipal(
  req: {
    header(name: string): string | undefined;
  },
  membership: MembershipRepository,
  auth: AuthRepository,
): Principal {
  return resolvePrincipal(req, membership, auth);
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

export { AuthorizationError };
