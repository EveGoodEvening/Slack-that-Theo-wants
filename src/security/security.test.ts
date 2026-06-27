import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import {
  appliedMigrations,
  migrateDown,
  migrateUp,
  migrations,
  type BetterSqliteDatabase,
} from '../db/index.js';
import { DomainRepository } from '../domain/index.js';
import {
  assertCanRead,
  assertCanWrite,
  AuthorizationError,
  authMiddleware,
  authorizeWriteBatch,
  filterByScope,
  hasRole,
  MembershipRepository,
  installAuthorizationErrorHandler,
  PRINCIPAL_HEADERS,
  principalScope,
  readableByScope,
  requireRole,
  resolvePrincipal,
  workspaceScopePredicate,
  type Principal,
  type PrincipalRequest,
} from './index.js';

/**
 * C1a security baseline tests.
 *
 * Directly exercises the middleware/helper contracts required by the C1a
 * "Required verification":
 * - a principal cannot read or write outside its workspace/group through the
 *   shared middleware
 * - workspace/group scope filters include authorized records and exclude
 *   unauthorized records for human AND stubbed-agent principals
 *
 * These tests do not depend on C2 feed APIs or C8 event streams: they build
 * synthetic record collections and a tiny Hono app that mounts only the C1a
 * middleware, proving the authorization contract in isolation.
 */

let db: BetterSqliteDatabase;
let domain: DomainRepository;
let membership: MembershipRepository;

beforeAll(() => {
  db = openDatabase(':memory:');
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  let applied = appliedMigrations(db);
  while (applied.length > 0) {
    migrateDown(db, migrations, applied[applied.length - 1]);
    applied = appliedMigrations(db);
  }
  migrateUp(db, migrations);
  domain = new DomainRepository(db);
  membership = new MembershipRepository(db);
});

/**
 * Two-workspace fixture: each workspace has one human and one agent actor.
 * The membership trigger auto-creates a 'write' membership for every actor in
 * its own workspace. Returns the created ids so tests can build principals.
 */
function twoWorkspaceFixture() {
  const wsA = domain.createWorkspace({ id: 'wsA', slug: 'team-a', name: 'Team A' });
  const wsB = domain.createWorkspace({ id: 'wsB', slug: 'team-b', name: 'Team B' });

  const humanA = domain.createActor({
    id: 'humanA',
    workspaceId: wsA.id,
    kind: 'human',
    displayName: 'Ada',
  });
  const agentA = domain.createActor({
    id: 'agentA',
    workspaceId: wsA.id,
    kind: 'agent',
    displayName: 'AgentA',
  });
  const humanB = domain.createActor({
    id: 'humanB',
    workspaceId: wsB.id,
    kind: 'human',
    displayName: 'Bo',
  });
  const agentB = domain.createActor({
    id: 'agentB',
    workspaceId: wsB.id,
    kind: 'agent',
    displayName: 'AgentB',
  });

  return { wsA, wsB, humanA, agentA, humanB, agentB };
}

/** A synthetic record with a workspace id, standing in for a feed/event row. */
interface ScopedRecord {
  id: string;
  workspaceId: string;
  payload: string;
}

function records(): ScopedRecord[] {
  return [
    { id: 'r1', workspaceId: 'wsA', payload: 'a1' },
    { id: 'r2', workspaceId: 'wsB', payload: 'b1' },
    { id: 'r3', workspaceId: 'wsA', payload: 'a2' },
    { id: 'r4', workspaceId: 'wsB', payload: 'b2' },
  ];
}

function headersFor(actorId: string, workspaceId: string): Record<string, string> {
  return {
    [PRINCIPAL_HEADERS.actorId]: actorId,
    [PRINCIPAL_HEADERS.workspaceId]: workspaceId,
  };
}

/** Build a PrincipalRequest carrying the stubbed auth headers. */
function reqFor(actorId: string, workspaceId: string): PrincipalRequest {
  const headers: Record<string, string> = headersFor(actorId, workspaceId);
  return { header: (name: string) => headers[name] };
}

/** Resolve a principal via the real resolver (exercises membership + kind). */
function principalFor(actorId: string, workspaceId: string): Principal {
  return resolvePrincipal(reqFor(actorId, workspaceId), membership);
}

/** Build a Hono app with the shared authorization error mapper installed. */
function securityApp(): Hono<{ Variables: { principal: Principal } }> {
  const app = new Hono<{ Variables: { principal: Principal } }>();
  installAuthorizationErrorHandler(app);
  return app;
}

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

describe('C1a principal resolution (stubbed)', () => {
  it('resolves a human principal from stubbed auth headers', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    let captured: Principal | undefined;
    const app = securityApp();
    app.use('*', authMiddleware(membership));
    app.get('/who', (c) => {
      captured = c.get('principal');
      return c.json({ ok: true });
    });

    const res = await app.request('/who', { headers: headersFor(humanA.id, wsA.id) });
    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    const p = captured as Principal;
    expect(p.actorId).toBe('humanA');
    expect(p.workspaceId).toBe('wsA');
    expect(p.kind).toBe('human');
    expect(p.role).toBe('write');
  });

  it('resolves an agent principal identically to a human principal', () => {
    const { agentA, wsA } = twoWorkspaceFixture();
    const p = principalFor(agentA.id, wsA.id);
    expect(p.actorId).toBe('agentA');
    expect(p.kind).toBe('agent');
    expect(p.workspaceId).toBe('wsA');
    expect(p.role).toBe('write');
  });

  it('rejects a request missing principal headers with 401 missing_principal', async () => {
    twoWorkspaceFixture();
    const app = securityApp();
    app.use('*', authMiddleware(membership));
    app.get('/who', (c) => c.json({ ok: true }));

    const res = await app.request('/who');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('missing_principal');
  });

  it('rejects an unknown actor with 401 principal_not_found', async () => {
    const { wsA } = twoWorkspaceFixture();
    const app = securityApp();
    app.use('*', authMiddleware(membership));
    app.get('/who', (c) => c.json({ ok: true }));

    const res = await app.request('/who', { headers: headersFor('ghost', wsA.id) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('principal_not_found');
  });

  it('rejects an actor that is not a member of the requested workspace with 401', async () => {
    const { humanA, wsB } = twoWorkspaceFixture();
    const app = securityApp();
    app.use('*', authMiddleware(membership));
    app.get('/who', (c) => c.json({ ok: true }));

    // humanA belongs to wsA; claiming wsB must fail at resolution time.
    const res = await app.request('/who', { headers: headersFor(humanA.id, wsB.id) });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('principal_not_found');
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace read/write rejection through the shared middleware
// ---------------------------------------------------------------------------

describe('C1a cross-workspace isolation via middleware', () => {
  /**
   * Build a tiny app that mounts the C1a middleware and exposes a read and a
   * write route guarded by assertCanRead/assertCanWrite against a workspace id
   * taken from the path. This mirrors how C2/C3 will wire the contract without
   * depending on those surfaces.
   */
  function guardedApp() {
    const app = securityApp();
    app.use('*', authMiddleware(membership));
    app.get('/ws/:workspaceId/read', (c) => {
      const p = c.get('principal');
      assertCanRead(p, c.req.param('workspaceId'));
      return c.json({ ok: true, workspaceId: c.req.param('workspaceId') });
    });
    app.post('/ws/:workspaceId/write', (c) => {
      const p = c.get('principal');
      assertCanWrite(p, c.req.param('workspaceId'));
      return c.json({ ok: true, workspaceId: c.req.param('workspaceId') });
    });
    return app;
  }

  it('allows a human principal to read its own workspace', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsA.id}/read`, {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a human principal reading another workspace with workspace_mismatch', async () => {
    const { humanA, wsB } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsB.id}/read`, {
      headers: headersFor(humanA.id, 'wsA'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('rejects a human principal writing another workspace with workspace_mismatch', async () => {
    const { humanA, wsB } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsB.id}/write`, {
      method: 'POST',
      headers: headersFor(humanA.id, 'wsA'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('rejects a stubbed-agent principal reading another workspace', async () => {
    const { agentA, wsB } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsB.id}/read`, {
      headers: headersFor(agentA.id, 'wsA'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('rejects a stubbed-agent principal writing another workspace', async () => {
    const { agentA, wsB } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsB.id}/write`, {
      method: 'POST',
      headers: headersFor(agentA.id, 'wsA'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('allows a stubbed-agent principal to read and write its own workspace', async () => {
    const { agentA, wsA } = twoWorkspaceFixture();
    const app = guardedApp();
    const read = await app.request(`/ws/${wsA.id}/read`, {
      headers: headersFor(agentA.id, wsA.id),
    });
    expect(read.status).toBe(200);
    const write = await app.request(`/ws/${wsA.id}/write`, {
      method: 'POST',
      headers: headersFor(agentA.id, wsA.id),
    });
    expect(write.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Role enforcement (read-only principals cannot write)
// ---------------------------------------------------------------------------

describe('C1a role enforcement', () => {
  it('a read-only principal can read but cannot write its own workspace', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    // Downgrade humanA to read-only membership.
    membership.setMembership(wsA.id, humanA.id, 'read');

    const app = securityApp();
    app.use('*', authMiddleware(membership));
    app.get('/ws/:workspaceId/read', (c) => {
      assertCanRead(c.get('principal'), c.req.param('workspaceId'));
      return c.json({ ok: true });
    });
    app.post('/ws/:workspaceId/write', (c) => {
      assertCanWrite(c.get('principal'), c.req.param('workspaceId'));
      return c.json({ ok: true });
    });

    const read = await app.request(`/ws/${wsA.id}/read`, {
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(read.status).toBe(200);

    const write = await app.request(`/ws/${wsA.id}/write`, {
      method: 'POST',
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(write.status).toBe(403);
    const body = (await write.json()) as { code: string };
    expect(body.code).toBe('write_forbidden');
  });

  it('requireRole(write) blocks a read-only principal at the route boundary', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');

    const app = securityApp();
    app.use('/admin/*', requireRole(membership, 'write'));
    app.post('/admin/thing', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/thing', {
      method: 'POST',
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('write_forbidden');
  });

  it('requireRole(read) maps downstream write denials without a route catch', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');

    const app = securityApp();
    app.use('/editor/*', requireRole(membership, 'read'));
    app.post('/editor/:workspaceId', (c) => {
      assertCanWrite(c.get('principal'), c.req.param('workspaceId'));
      return c.json({ ok: true });
    });

    const res = await app.request(`/editor/${wsA.id}`, {
      method: 'POST',
      headers: headersFor(humanA.id, wsA.id),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('write_forbidden');
  });

  it('does not hide downstream non-authorization errors', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const app = securityApp();
    app.use('/editor/*', requireRole(membership, 'read'));
    app.get('/editor/boom', () => {
      throw new Error('unexpected route failure');
    });

    await expect(
      app.request('/editor/boom', { headers: headersFor(humanA.id, wsA.id) }),
    ).rejects.toThrow('unexpected route failure');
  });

  it('hasRole: write satisfies read and write; read satisfies only read', () => {
    const reader: Principal = {
      actorId: 'r',
      workspaceId: 'ws',
      kind: 'human',
      role: 'read',
    };
    const writer: Principal = {
      actorId: 'w',
      workspaceId: 'ws',
      kind: 'agent',
      role: 'write',
    };
    expect(hasRole(reader, 'read')).toBe(true);
    expect(hasRole(reader, 'write')).toBe(false);
    expect(hasRole(writer, 'read')).toBe(true);
    expect(hasRole(writer, 'write')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope/filter helpers — include authorized, exclude unauthorized, for human
// and stubbed-agent principals
// ---------------------------------------------------------------------------

describe('C1a scope/filter helpers', () => {
  function principals() {
    const { humanA, agentA, humanB, agentB } = twoWorkspaceFixture();
    // Build principals via the real resolver so tests exercise the membership
    // table + actor kind, not a hand-constructed shape.
    return {
      humanA: principalFor(humanA.id, 'wsA'),
      agentA: principalFor(agentA.id, 'wsA'),
      humanB: principalFor(humanB.id, 'wsB'),
      agentB: principalFor(agentB.id, 'wsB'),
    };
  }

  it('principalScope returns the principal workspace + role', () => {
    const { humanA } = principals();
    expect(principalScope(humanA)).toEqual({ workspaceId: 'wsA', role: 'write' });
  });

  it('workspaceScopePredicate matches only the scope workspace', () => {
    const pred = workspaceScopePredicate({ workspaceId: 'wsA', role: 'write' });
    expect(pred('wsA')).toBe(true);
    expect(pred('wsB')).toBe(false);
  });

  it('filterByScope includes only records in the human principal workspace', () => {
    const { humanA } = principals();
    const filtered = filterByScope(humanA, records(), (r) => r.workspaceId);
    expect(filtered.map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('filterByScope excludes records from other workspaces for a human principal', () => {
    const { humanA } = principals();
    const filtered = filterByScope(humanA, records(), (r) => r.workspaceId);
    expect(filtered.some((r) => r.workspaceId === 'wsB')).toBe(false);
  });

  it('filterByScope includes only records in the stubbed-agent principal workspace', () => {
    const { agentA } = principals();
    const filtered = filterByScope(agentA, records(), (r) => r.workspaceId);
    expect(filtered.map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('filterByScope excludes records from other workspaces for a stubbed-agent principal', () => {
    const { agentB } = principals();
    const filtered = filterByScope(agentB, records(), (r) => r.workspaceId);
    expect(filtered.map((r) => r.id).sort()).toEqual(['r2', 'r4']);
    expect(filtered.some((r) => r.workspaceId === 'wsA')).toBe(false);
  });

  it('readableByScope asserts read role then filters (authorized human)', () => {
    const { humanA } = principals();
    const filtered = readableByScope(humanA, records(), (r) => r.workspaceId);
    expect(filtered.map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('readableByScope asserts read role then filters (authorized agent)', () => {
    const { agentA } = principals();
    const filtered = readableByScope(agentA, records(), (r) => r.workspaceId);
    expect(filtered.map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('readableByScope filters normally for a read-only principal (read role satisfies read)', () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');
    const p = principalFor(humanA.id, wsA.id);
    expect(p.role).toBe('read');
    expect(readableByScope(p, records(), (r) => r.workspaceId).map((r) => r.id)).toEqual([
      'r1',
      'r3',
    ]);
  });

  it('authorizeWriteBatch rejects a batch with any cross-workspace record', () => {
    const { humanA } = principals();
    const batch: ScopedRecord[] = [
      { id: 'r1', workspaceId: 'wsA', payload: 'ok' },
      { id: 'r2', workspaceId: 'wsB', payload: 'cross' },
    ];
    expect(() => authorizeWriteBatch(humanA, batch, (r) => r.workspaceId)).toThrowError(
      AuthorizationError,
    );
  });

  it('authorizeWriteBatch accepts an all-in-workspace batch for a human and an agent', () => {
    const { humanA, agentA } = principals();
    const batch: ScopedRecord[] = [
      { id: 'r1', workspaceId: 'wsA', payload: 'ok1' },
      { id: 'r3', workspaceId: 'wsA', payload: 'ok2' },
    ];
    expect(authorizeWriteBatch(humanA, batch, (r) => r.workspaceId)).toBe(batch);
    expect(authorizeWriteBatch(agentA, batch, (r) => r.workspaceId)).toBe(batch);
  });

  it('authorizeWriteBatch rejects a read-only principal even in its own workspace', () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');
    const p = principalFor(humanA.id, wsA.id);
    const batch: ScopedRecord[] = [{ id: 'r1', workspaceId: 'wsA', payload: 'x' }];
    expect(() => authorizeWriteBatch(p, batch, (r) => r.workspaceId)).toThrowError(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Membership model baseline
// ---------------------------------------------------------------------------

describe('C1a baseline membership model', () => {
  it('auto-creates a write membership for every new actor in its own workspace', () => {
    const { humanA, agentA, wsA } = twoWorkspaceFixture();
    expect(membership.getMembership(wsA.id, humanA.id)?.role).toBe('write');
    expect(membership.getMembership(wsA.id, agentA.id)?.role).toBe('write');
  });

  it('an actor has no membership in another workspace', () => {
    const { humanA, wsB } = twoWorkspaceFixture();
    expect(membership.getMembership(wsB.id, humanA.id)).toBeUndefined();
  });

  it('listMembershipsForActor returns only the actor own workspace', () => {
    const { humanA } = twoWorkspaceFixture();
    const rows = membership.listMembershipsForActor(humanA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspaceId).toBe('wsA');
  });

  it('listMembersInWorkspace enumerates both human and agent members', () => {
    const { wsA, humanA, agentA } = twoWorkspaceFixture();
    const ids = membership
      .listMembersInWorkspace(wsA.id)
      .map((m) => m.actorId)
      .sort();
    expect(ids).toEqual([agentA.id, humanA.id].sort());
  });

  it('setMembership can downgrade a member to read-only', () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    membership.setMembership(wsA.id, humanA.id, 'read');
    expect(membership.getMembership(wsA.id, humanA.id)?.role).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// Migration 0002 apply/rollback
// ---------------------------------------------------------------------------

describe('C1a membership migration', () => {
  it('applies migration 0002 alongside migration 0001 on a fresh database', () => {
    expect(appliedMigrations(db)).toEqual([1, 2, 3]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('workspace_member');
  });

  it('rolls back migration 0002 cleanly leaving the C1 schema intact', () => {
    migrateDown(db, migrations, 2);
    expect(appliedMigrations(db)).toEqual([1]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain('workspace_member');
    expect(tables.map((t) => t.name)).toContain('post');
  });
});
