import { AuthorizationError, type Principal, type Role, type WorkspaceScope } from './types.js';

/**
 * C1a shared authorization helpers.
 *
 * Pure functions over a Principal — no request, no DB. These are the reusable
 * scope/filter contracts every later surface (C2 feed, C3 comments, C7 agent
 * control plane, C8 realtime events, status) consumes to enforce
 * workspace/group isolation and per-endpoint read/write scope.
 *
 * Invariants:
 * - A principal may only read or write within its own workspace.
 * - 'write' role implies 'read'; 'read' role cannot write.
 * - Collection filters exclude any record whose workspace differs from the
 *   principal's workspace, for both human and agent principals.
 */

/** The scope a principal is authorized for: its workspace + role. */
export function principalScope(principal: Principal): WorkspaceScope {
  return { workspaceId: principal.workspaceId, role: principal.role };
}

/** True if the principal's role satisfies the required role. */
export function hasRole(principal: Principal, required: Role): boolean {
  if (required === 'read') {
    // 'read' and 'write' both satisfy a read requirement.
    return principal.role === 'read' || principal.role === 'write';
  }
  // required === 'write'
  return principal.role === 'write';
}

/**
 * Assert the principal may read within `workspaceId`. Throws
 * AuthorizationError('workspace_mismatch' | 'read_forbidden') on failure.
 */
export function assertCanRead(
  principal: Principal,
  workspaceId: string,
): void {
  if (principal.workspaceId !== workspaceId) {
    throw new AuthorizationError(
      'workspace_mismatch',
      `principal ${principal.actorId} (${principal.workspaceId}) cannot read workspace ${workspaceId}`,
    );
  }
  if (!hasRole(principal, 'read')) {
    throw new AuthorizationError(
      'read_forbidden',
      `principal ${principal.actorId} lacks read role in workspace ${workspaceId}`,
    );
  }
}

/**
 * Assert the principal may write within `workspaceId`. Throws
 * AuthorizationError('workspace_mismatch' | 'write_forbidden') on failure.
 */
export function assertCanWrite(
  principal: Principal,
  workspaceId: string,
): void {
  if (principal.workspaceId !== workspaceId) {
    throw new AuthorizationError(
      'workspace_mismatch',
      `principal ${principal.actorId} (${principal.workspaceId}) cannot write workspace ${workspaceId}`,
    );
  }
  if (!hasRole(principal, 'write')) {
    throw new AuthorizationError(
      'write_forbidden',
      `principal ${principal.actorId} lacks write role in workspace ${workspaceId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reusable collection scope/filter helpers
// ---------------------------------------------------------------------------

/**
 * A predicate over a record's workspace id, built from a principal's scope.
 * Used by `filterByScope` so later surfaces can scope any collection without
 * re-implementing the boundary check.
 */
export function workspaceScopePredicate(
  scope: WorkspaceScope,
): (workspaceId: string) => boolean {
  return (workspaceId) => workspaceId === scope.workspaceId;
}

/**
 * Filter a collection of records to those the principal is authorized to read.
 * Each record is projected to its workspace id by `getWorkspaceId`. Records in
 * other workspaces are excluded — for both human and agent principals. This is
 * the shared filter C2 (feed), C3 (subtree), C7 (agent feed polling), and C8
 * (realtime event fan-out) apply before ordering/pagination.
 */
export function filterByScope<T>(
  principal: Principal,
  records: readonly T[],
  getWorkspaceId: (record: T) => string,
): T[] {
  const inScope = workspaceScopePredicate(principalScope(principal));
  return records.filter((record) => inScope(getWorkspaceId(record)));
}

/**
 * Filter a collection to records the principal is authorized to read, asserting
 * the principal has read role first. Use this on read paths that also want the
 * role check; use `filterByScope` when the role check is done upstream.
 */
export function readableByScope<T>(
  principal: Principal,
  records: readonly T[],
  getWorkspaceId: (record: T) => string,
): T[] {
  assertCanRead(principal, principal.workspaceId);
  return filterByScope(principal, records, getWorkspaceId);
}

/**
 * Reject an entire write batch if any record targets a workspace the principal
 * cannot write to. Throws on the first unauthorized record; returns the input
 * unchanged when all records are authorized. Used by C2/C3/C7 bulk write paths.
 */
export function authorizeWriteBatch<T>(
  principal: Principal,
  records: readonly T[],
  getWorkspaceId: (record: T) => string,
): readonly T[] {
  for (const record of records) {
    assertCanWrite(principal, getWorkspaceId(record));
  }
  return records;
}
