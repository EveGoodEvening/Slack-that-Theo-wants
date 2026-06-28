// Shared security: C1a authorization contracts plus C9 auth/collaboration primitives.

export { MembershipRepository } from './membership.js';
export type {
  InviteStatus,
  MembershipRow,
  MembershipStatus,
  ResolvedMembership,
  ShareStatus,
  WorkspaceInviteRow,
  WorkspaceShareRow,
} from './membership.js';

export {
  membershipToPrincipal,
  resolvePrincipal,
} from './principal.js';
export type { PrincipalRequest } from './principal.js';


export {
  AuthenticationError,
  AuthRepository,
  clearSessionCookie,
  generateSessionSecret,
  hashPassword,
  hashSessionSecret,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_SCHEME,
  sessionCookie,
  sessionSecretFromRequest,
  verifyPassword,
} from './auth.js';
export type { AuthIdentityRow, AuthSessionRow, IssuedSession } from './auth.js';
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
  authorizationErrorHandler,
  installAuthorizationErrorHandler,
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

// C7 agent control-plane security modules.
export {
  AgentCredentialRepository,
  generateSecret,
  hashSecret,
  verifySecret,
} from './credentials.js';
export type {
  AgentCredentialRow,
  IssuedCredential,
  VerifiedCredential,
} from './credentials.js';

export {
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_SCHEME,
  resolveAgentPrincipal,
} from './agentPrincipal.js';
export type { AgentPrincipalRequest } from './agentPrincipal.js';

export { AgentAuditRepository } from './audit.js';
export type { AgentAuditRow, AgentWriteAction } from './audit.js';

export { AgentIdempotencyRepository, IdempotencyKeyReuseError, requestDigest } from './idempotency.js';

export {
  AgentQuotaRepository,
  DEFAULT_AGENT_QUOTA,
  QuotaExceededError,
} from './rateLimit.js';
export type { QuotaConfig } from './rateLimit.js';

export { AgentProfileRepository } from './agentProfile.js';
export type { AgentProfileRow, AgentStatus } from './agentProfile.js';
