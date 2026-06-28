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
import { authRoutes } from '../api/authRoutes.js';
import {
  assertCanRead,
  assertCanWrite,
  AuthorizationError,
  AuthRepository,
  authMiddleware,
  authorizeWriteBatch,
  filterByScope,
  hasRole,
  MembershipRepository,
  installAuthorizationErrorHandler,
  principalScope,
  readableByScope,
  requireRole,
  resolvePrincipal,
  SESSION_COOKIE_NAME,
  sessionCookie,
  workspaceScopePredicate,
  type Principal,
  type PrincipalRequest,
} from './index.js';

/**
 * Shared security tests for the C1a authorization contract after the C9
 * session-backed principal replacement.
 *
 * Directly exercises the middleware/helper contracts required by C1a and C9:
 * - a principal cannot read or write outside its workspace/group through the
 *   shared middleware
 * - workspace/group scope filters include authorized records and exclude
 *   unauthorized records for human and agent principals
 * - C9 sessions replace the old header-only principal stub on protected paths
 *
 * These tests do not depend on C8 event streams: they build synthetic record
 * collections and tiny Hono apps that mount only the security routes needed for
 * each contract.
 */

let db: BetterSqliteDatabase;
let domain: DomainRepository;
let membership: MembershipRepository;
let auth: AuthRepository;

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
  auth = new AuthRepository(db);
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
  const session = auth.createSession({ actorId, workspaceId });
  return { cookie: sessionCookie(session.secret) };
}

/** Build a PrincipalRequest carrying a sign-in session cookie. */
function reqFor(actorId: string, workspaceId: string): PrincipalRequest {
  const headers: Record<string, string> = headersFor(actorId, workspaceId);
  return { header: (name: string) => headers[name.toLowerCase()] ?? headers[name] };
}

/** Resolve a principal via the real resolver (exercises membership + kind). */
function principalFor(actorId: string, workspaceId: string): Principal {
  return resolvePrincipal(reqFor(actorId, workspaceId), membership, auth);
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

describe('C9 principal resolution (session-backed)', () => {
  it('resolves a human principal from a sign-in session cookie', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    let captured: Principal | undefined;
    const app = securityApp();
    app.use('*', authMiddleware(membership, auth));
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

  it('rejects a request missing a sign-in session with 401 missing_principal', async () => {
    twoWorkspaceFixture();
    const app = securityApp();
    app.use('*', authMiddleware(membership, auth));
    app.get('/who', (c) => c.json({ ok: true }));

    const res = await app.request('/who');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('missing_principal');
  });

  it('rejects an unknown session with 401 principal_not_found', async () => {
    twoWorkspaceFixture();
    const app = securityApp();
    app.use('*', authMiddleware(membership, auth));
    app.get('/who', (c) => c.json({ ok: true }));

    const res = await app.request('/who', { headers: { cookie: sessionCookie('sttw_session_unknown') } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('principal_not_found');
  });

  it('rejects a session whose membership is no longer active with 401', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const headers = headersFor(humanA.id, wsA.id);
    membership.suspendMembership(wsA.id, humanA.id);
    const app = securityApp();
    app.use('*', authMiddleware(membership, auth));
    app.get('/who', (c) => c.json({ ok: true }));

    const res = await app.request('/who', { headers });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('principal_not_found');
  });

  it('does not accept legacy x-actor-id / x-workspace-id headers without a session', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    const app = securityApp();
    app.use('*', authMiddleware(membership, auth));
    app.get('/who', (c) => c.json({ ok: true }));

    const res = await app.request('/who', {
      headers: { 'x-actor-id': humanA.id, 'x-workspace-id': wsA.id },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('missing_principal');
  });

  it('issues a session cookie through the sign-in route', async () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    auth.createIdentity({
      actorId: humanA.id,
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });
    const app = new Hono();
    app.route('/auth', authRoutes({ auth }));
    const form = new URLSearchParams();
    form.set('email', 'ADA@example.com');
    form.set('password', 'correct horse battery staple');
    form.set('workspaceId', wsA.id);

    const res = await app.request('/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/feed');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    const principal = resolvePrincipal(
      { header: (name) => (name === 'cookie' ? cookie : undefined) },
      membership,
      auth,
    );
    expect(principal.actorId).toBe(humanA.id);
    expect(principal.workspaceId).toBe(wsA.id);
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
    app.use('*', authMiddleware(membership, auth));
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

  it('rejects a session-backed agent principal reading another workspace', async () => {
    const { agentA, wsB } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsB.id}/read`, {
      headers: headersFor(agentA.id, 'wsA'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('rejects a session-backed agent principal writing another workspace', async () => {
    const { agentA, wsB } = twoWorkspaceFixture();
    const res = await guardedApp().request(`/ws/${wsB.id}/write`, {
      method: 'POST',
      headers: headersFor(agentA.id, 'wsA'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_mismatch');
  });

  it('allows a session-backed agent principal to read and write its own workspace', async () => {
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
    app.use('*', authMiddleware(membership, auth));
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
    app.use('/admin/*', requireRole(membership, 'write', auth));
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
    app.use('/editor/*', requireRole(membership, 'read', auth));
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
    app.use('/editor/*', requireRole(membership, 'read', auth));
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
// and session-backed agent principals
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

  it('filterByScope includes only records in the session-backed agent principal workspace', () => {
    const { agentA } = principals();
    const filtered = filterByScope(agentA, records(), (r) => r.workspaceId);
    expect(filtered.map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('filterByScope excludes records from other workspaces for a session-backed agent principal', () => {
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
// C9 local auth + membership lifecycle
// ---------------------------------------------------------------------------

describe('C9 local auth and collaboration membership', () => {
  it('authenticates a human identity and resolves a session principal', () => {
    const { humanA, wsA } = twoWorkspaceFixture();
    auth.createIdentity({
      actorId: humanA.id,
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    });

    const session = auth.authenticate({
      email: 'ADA@example.com',
      password: 'correct horse battery staple',
      workspaceId: wsA.id,
    });
    const principal = resolvePrincipal(
      { header: (name) => (name === 'cookie' ? sessionCookie(session.secret) : undefined) },
      membership,
      auth,
    );

    expect(principal).toEqual({
      actorId: humanA.id,
      workspaceId: wsA.id,
      kind: 'human',
      role: 'write',
    });
  });

  it('rejects identities for agent actors', () => {
    const { agentA } = twoWorkspaceFixture();
    expect(() =>
      auth.createIdentity({
        actorId: agentA.id,
        email: 'agent@example.com',
        password: 'not-for-agents',
      }),
    ).toThrow();
  });

  it('keeps invited memberships inactive until accepted', () => {
    const { wsA, humanA, humanB } = twoWorkspaceFixture();
    const invited = membership.inviteMember({
      workspaceId: wsA.id,
      actorId: humanB.id,
      role: 'read',
      invitedByActorId: humanA.id,
    });

    expect(invited.status).toBe('invited');
    expect(membership.resolveMembership(wsA.id, humanB.id)).toBeUndefined();

    const accepted = membership.acceptMembership(wsA.id, humanB.id);
    expect(accepted.status).toBe('active');
    expect(membership.resolveMembership(wsA.id, humanB.id)?.role).toBe('read');
  });

  it('does not downgrade an active membership back to invited', () => {
    const { wsA, humanA } = twoWorkspaceFixture();
    const invited = membership.inviteMember({
      workspaceId: wsA.id,
      actorId: humanA.id,
      role: 'read',
      invitedByActorId: humanA.id,
    });

    expect(invited.status).toBe('active');
    expect(membership.resolveMembership(wsA.id, humanA.id)?.role).toBe('write');
  });

  it('accepting an invite creates active membership for the invited actor', () => {
    const { wsA, humanA, humanB } = twoWorkspaceFixture();
    const invite = membership.createInvite({
      workspaceId: wsA.id,
      email: 'bo@example.com',
      role: 'write',
      invitedByActorId: humanA.id,
    });

    const accepted = membership.acceptInvite(invite.id, humanB.id);

    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedByActorId).toBe(humanB.id);
    expect(membership.resolveMembership(wsA.id, humanB.id)?.role).toBe('write');
  });

  it('does not accept a revoked invite', () => {
    const { wsA, humanA, humanB } = twoWorkspaceFixture();
    const invite = membership.createInvite({
      workspaceId: wsA.id,
      email: 'revoked@example.com',
      role: 'read',
      invitedByActorId: humanA.id,
    });

    membership.revokeInvite(invite.id);

    expect(() => membership.acceptInvite(invite.id, humanB.id)).toThrow(/not pending/);
    expect(membership.resolveMembership(wsA.id, humanB.id)).toBeUndefined();
  });

  it('workspace shares grant and revoke cross-workspace membership', () => {
    const { wsA, wsB, humanA, humanB } = twoWorkspaceFixture();
    const share = membership.createShare({
      workspaceId: wsB.id,
      actorId: humanA.id,
      role: 'write',
      sharedByActorId: humanB.id,
    });

    expect(share.status).toBe('active');
    expect(membership.resolveMembership(wsB.id, humanA.id)?.role).toBe('write');
    expect(membership.listMembershipsForActor(humanA.id).map((m) => m.workspaceId).sort()).toEqual([
      wsA.id,
      wsB.id,
    ]);

    const revoked = membership.revokeShare(share.id);
    expect(revoked.status).toBe('revoked');
    expect(membership.resolveMembership(wsB.id, humanA.id)).toBeUndefined();
  });

  it('revoking a share restores an accepted invite role instead of deleting membership', () => {
    const { wsB, humanA, humanB } = twoWorkspaceFixture();
    const invite = membership.createInvite({
      workspaceId: wsB.id,
      email: 'ada@example.com',
      role: 'read',
      invitedByActorId: humanB.id,
    });
    membership.acceptInvite(invite.id, humanA.id);
    const share = membership.createShare({
      workspaceId: wsB.id,
      actorId: humanA.id,
      role: 'write',
      sharedByActorId: humanB.id,
    });
    expect(membership.resolveMembership(wsB.id, humanA.id)?.role).toBe('write');

    membership.revokeShare(share.id);

    const restored = membership.resolveMembership(wsB.id, humanA.id);
    expect(restored?.role).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// Migration 0004 apply / pre-C9 preservation / rollback
// ---------------------------------------------------------------------------

describe('C9 auth/collaboration migration', () => {
  it('applies C9 auth/collaboration tables on a fresh database', () => {
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('auth_identity');
    expect(names).toContain('auth_session');
    expect(names).toContain('workspace_invite');
    expect(names).toContain('workspace_share');
    const memberColumns = db
      .prepare('PRAGMA table_info(workspace_member)')
      .all() as { name: string }[];
    expect(memberColumns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['status', 'invited_by_actor_id', 'accepted_at']),
    );
  });

  it('migrates from pre-C9 data without losing existing workspace content or memberships', () => {
    migrateDown(db, migrations, 4);
    expect(appliedMigrations(db)).toEqual([1, 2, 3]);

    const preRepo = new DomainRepository(db);
    preRepo.createWorkspace({ id: 'preWs', slug: 'pre', name: 'Pre C9' });
    preRepo.createActor({ id: 'preHuman', workspaceId: 'preWs', kind: 'human', displayName: 'Pre Human' });
    preRepo.createPost({
      id: 'prePost',
      workspaceId: 'preWs',
      authorActorId: 'preHuman',
      content: 'pre-C9 post',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    preRepo.createComment({
      id: 'preComment',
      workspaceId: 'preWs',
      rootPostId: 'prePost',
      authorActorId: 'preHuman',
      content: 'pre-C9 comment',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    migrateUp(db, migrations);
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4]);

    const post = new DomainRepository(db).getPost('prePost');
    const comment = new DomainRepository(db).getComment('preComment');
    expect(post && !('isDeleted' in post) ? post.content : undefined).toBe('pre-C9 post');
    expect(comment && !('isDeleted' in comment) ? comment.content : undefined).toBe('pre-C9 comment');
    expect(new MembershipRepository(db).resolveMembership('preWs', 'preHuman')?.role).toBe('write');
  });

  it('rolls migration 0004 back cleanly to the pre-C9 schema shape', () => {
    migrateDown(db, migrations, 4);
    expect(appliedMigrations(db)).toEqual([1, 2, 3]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).not.toContain('auth_identity');
    expect(names).not.toContain('auth_session');
    expect(names).not.toContain('workspace_invite');
    const memberColumns = db
      .prepare('PRAGMA table_info(workspace_member)')
      .all() as { name: string }[];
    expect(memberColumns.map((c) => c.name)).not.toContain('status');

    migrateUp(db, migrations);
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Migration 0002 apply/rollback
// ---------------------------------------------------------------------------

describe('C1a membership migration', () => {
  it('applies migration 0002 alongside migration 0001 on a fresh database', () => {
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4]);
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
