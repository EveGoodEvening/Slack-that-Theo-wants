// C1a security baseline: principal, membership, authorization middleware.

export { MembershipRepository } from './membership.js';
export type { MembershipRow, ResolvedMembership } from './membership.js';

export {
  membershipToPrincipal,
  PRINCIPAL_HEADERS,
  resolvePrincipal,
} from './principal.js';
export type { PrincipalRequest } from './principal.js';

export {
  assertCanRead,
  assertCanWrite,
  authorizeWriteBatch,
  filterByScope,
  hasRole,
  principalScope,
  readableByScope,
  workspaceScopePredicate,
} from './authorization.js';

export {
  authMiddleware,
  authorizationErrorResponse,
  getPrincipal,
  requireRole,
  type AuthVariables,
} from './middleware.js';

export { AuthorizationError } from './types.js';
export type {
  AuthorizationCode,
  Principal,
  Role,
  WorkspaceScope,
} from './types.js';
