import type { ActorKind } from '../domain/types.js';

/**
 * Shared security types: principal, membership, authorization.
 *
 * C1a introduced the Principal shape and workspace/group authorization helpers;
 * C9 replaces the old header-only resolver with sign-in sessions while keeping
 * this shape as the common contract for human app/API routes and agent
 * credentials. The shared middleware and per-endpoint read/write scope checks
 * consume these types across C2/C3/C7/C8.
 */

/** Authorization role. 'write' implies 'read'. */
export type Role = 'read' | 'write';

/**
 * A resolved principal: the actor making a request, the workspace/group it acts
 * in, its kind (human | agent), and its membership role within that workspace.
 *
 * Human app/API principals come from C9 auth sessions; agent principals come
 * from scoped agent credentials. Both paths validate an active membership
 * before producing this shape.
 */
export interface Principal {
  actorId: string;
  workspaceId: string;
  kind: ActorKind;
  role: Role;
}

/**
 * The access scope a principal is authorized for. Every read/write path
 * resolves to one of these so collection filters and single-resource guards
 * share one representation of "what am I allowed to touch".
 */
export interface WorkspaceScope {
  workspaceId: string;
  role: Role;
}

/** Machine-readable authorization failure codes (stable for clients/agents). */
export type AuthorizationCode =
  | 'missing_principal'
  | 'principal_not_found'
  | 'not_member'
  | 'read_forbidden'
  | 'write_forbidden'
  | 'workspace_mismatch';

/** Authorization failure with an HTTP status and machine-readable code. */
export class AuthorizationError extends Error {
  readonly status: number;
  readonly code: AuthorizationCode;

  constructor(code: AuthorizationCode, message: string, status = 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
    this.status = status;
  }
}
