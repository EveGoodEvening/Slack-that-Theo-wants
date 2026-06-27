import type { ActorKind } from '../domain/types.js';

/**
 * C1a security baseline: principal, membership, authorization.
 *
 * This module owns the request→principal resolution (stubbed auth, replaced by
 * C9 real sign-in), the baseline workspace/group membership model, and the
 * shared authorization middleware + reusable scope/filter helpers consumed by
 * every later exposed API, realtime, and agent surface (C2/C3/C7/C8).
 *
 * Real sign-in, invite/share, and the full membership lifecycle are deferred to
 * C9. The shared middleware and per-endpoint read/write scope checks persist
 * across that replacement.
 */

/** Authorization role. 'write' implies 'read'. */
export type Role = 'read' | 'write';

/**
 * A resolved principal: the actor making a request, the workspace/group it acts
 * in, its kind (human | agent), and its membership role within that workspace.
 *
 * `resolvePrincipal` is the single stubbed entry point that produces a
 * Principal from a request. C9 swaps the stub for real sign-in; the Principal
 * shape and the middleware that consume it stay the same.
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
