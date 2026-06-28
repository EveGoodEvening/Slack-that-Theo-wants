import type { Hono } from 'hono';
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
import { createApp, type AppDeps } from '../index.js';
import {
  AgentCredentialRepository,
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_SCHEME,
  MembershipRepository,
} from '../security/index.js';
import { AuthRepository, sessionCookie } from '../security/auth.js';
import { IDEMPOTENCY_HEADER } from './agentService.js';
import { ACTIVITY_EVENT_TYPES, type ActivityEvent } from './activityEvents.js';

/**
 * C8 realtime activity tests.
 *
 * These exercise the app-level SSE route plus shared service-layer publication:
 * C2 post writes, C3 comment writes, and C7 agent replies all emit the same
 * versioned actor-agnostic contract, and fan-out is filtered by workspace.
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
    const latest = expectArrayItem(applied, applied.length - 1);
    migrateDown(db, migrations, latest);
    applied = appliedMigrations(db);
  }
  migrateUp(db, migrations);
  domain = new DomainRepository(db);
  membership = new MembershipRepository(db);
  auth = new AuthRepository(db);
});

function app(): Hono {
  const deps: AppDeps = { repository: domain, membership, auth, db };
  return createApp(deps);
}

function headersFor(actorId: string, workspaceId: string): Record<string, string> {
  const session = auth.createSession({ actorId, workspaceId });
  return { cookie: sessionCookie(session.secret) };
}

function bearerToken(secret: string): Record<string, string> {
  return { [AGENT_TOKEN_HEADER]: `${AGENT_TOKEN_SCHEME} ${secret}` };
}

function idempotencyHeader(key: string): Record<string, string> {
  return { [IDEMPOTENCY_HEADER]: key };
}

function expectArrayItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  expect(item).toBeDefined();
  if (item === undefined) {
    throw new Error(`expected array item at index ${index}`);
  }
  return item;
}

function twoWorkspaceFixture(): void {
  domain.createWorkspace({ id: 'wsA', slug: 'team-a', name: 'Team A' });
  domain.createWorkspace({ id: 'wsB', slug: 'team-b', name: 'Team B' });
  domain.createActor({ id: 'humanA', workspaceId: 'wsA', kind: 'human', displayName: 'Ada' });
  domain.createActor({ id: 'humanB', workspaceId: 'wsB', kind: 'human', displayName: 'Bo' });
  domain.createActor({ id: 'agentA', workspaceId: 'wsA', kind: 'agent', displayName: 'Agent A' });
}

function seedPost(
  id: string,
  workspaceId: string,
  authorActorId: string,
  content: string,
  lastActivityAt: string,
): void {
  domain.createPost({ id, workspaceId, authorActorId, content, lastActivityAt });
}

interface ActivityStreamTestReader {
  nextEvent(): Promise<ActivityEvent>;
  nextEventOrClosed(): Promise<ActivityEvent | undefined>;
  cancel(): Promise<void>;
}

async function openActivityStream(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
): Promise<ActivityStreamTestReader> {
  return openActivityStreamWithHeaders(appInstance, headersFor(actorId, workspaceId));
}

async function openActivityStreamWithHeaders(
  appInstance: Hono,
  headers: Record<string, string>,
): Promise<ActivityStreamTestReader> {
  const res = await appInstance.request('/events', { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error('expected SSE response body');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const readNextEvent = async (): Promise<ActivityEvent | undefined> => {
    while (true) {
      const separator = buffer.indexOf('\n\n');
      if (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseSseBlock(block);
        if (parsed !== undefined) return parsed;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    async nextEvent(): Promise<ActivityEvent> {
      const event = await readNextEvent();
      if (event !== undefined) return event;
      throw new Error('SSE stream ended before an activity event arrived');
    },
    async nextEventOrClosed(): Promise<ActivityEvent | undefined> {
      return readNextEvent();
    },
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

function parseSseBlock(block: string): ActivityEvent | undefined {
  const lines = block.split('\n');
  const dataLines = lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  if (dataLines.length === 0) return undefined;
  return JSON.parse(dataLines.join('\n')) as ActivityEvent;
}

async function createPostViaApi(
  appInstance: Hono,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ id: string; workspaceId: string; lastActivityAt: string }> {
  const res = await appInstance.request('/posts', {
    method: 'POST',
    headers: { ...headersFor(actorId, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; workspaceId: string; lastActivityAt: string };
}

async function createCommentViaApi(
  appInstance: Hono,
  postId: string,
  actorId: string,
  workspaceId: string,
  content: string,
): Promise<{ id: string; rootPostId: string }> {
  const res = await appInstance.request(`/posts/${postId}/comments`, {
    method: 'POST',
    headers: { ...headersFor(actorId, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; rootPostId: string };
}

async function createAgentReplyViaApi(
  appInstance: Hono,
  parentId: string,
  secret: string,
  idempotencyKey: string,
  content: string,
): Promise<{ id: string; rootPostId: string; parentId: string }> {
  const res = await appInstance.request(`/agents/comments/${parentId}/replies`, {
    method: 'POST',
    headers: {
      ...bearerToken(secret),
      ...idempotencyHeader(idempotencyKey),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    result: { id: string; rootPostId: string; parentId: string };
  };
  return body.result;
}

describe('C8 activity SSE contract', () => {
  it('streams post, comment, and agent reply events from the shared write services', async () => {
    twoWorkspaceFixture();
    const issued = new AgentCredentialRepository(db).issue({
      actorId: 'agentA',
      workspaceId: 'wsA',
    });
    const a = app();
    const stream = await openActivityStream(a, 'humanA', 'wsA');
    try {
      const post = await createPostViaApi(a, 'humanA', 'wsA', 'hello realtime');
      const postEvent = await stream.nextEvent();
      expect(postEvent.type).toBe(ACTIVITY_EVENT_TYPES.postCreated);
      if (postEvent.type !== ACTIVITY_EVENT_TYPES.postCreated) {
        throw new Error('expected post-created activity event');
      }
      expect(postEvent.version).toBe(1);
      expect(postEvent.workspaceId).toBe('wsA');
      expect(postEvent.rootPostId).toBe(post.id);
      expect('content' in postEvent.post).toBe(false);

      const comment = await createCommentViaApi(a, post.id, 'humanA', 'wsA', 'first comment');
      const commentEvent = await stream.nextEvent();
      expect(commentEvent.type).toBe(ACTIVITY_EVENT_TYPES.commentCreated);
      expect(commentEvent.rootPostId).toBe(post.id);
      if (commentEvent.type === ACTIVITY_EVENT_TYPES.commentCreated) {
        expect(commentEvent.comment.id).toBe(comment.id);
        expect(commentEvent.comment.parentId).toBeNull();
      }

      const reply = await createAgentReplyViaApi(
        a,
        comment.id,
        issued.secret,
        'agent-reply-1',
        'agent reply',
      );
      const replyEvent = await stream.nextEvent();
      expect(replyEvent.type).toBe(ACTIVITY_EVENT_TYPES.replyCreated);
      expect(replyEvent.rootPostId).toBe(post.id);
      if (replyEvent.type === ACTIVITY_EVENT_TYPES.replyCreated) {
        expect(replyEvent.comment.id).toBe(reply.id);
        expect(replyEvent.comment.parentId).toBe(comment.id);
      }
    } finally {
      await stream.cancel();
    }
  });

  it('filters events by workspace so cross-workspace writes do not leak', async () => {
    twoWorkspaceFixture();
    seedPost('postA', 'wsA', 'humanA', 'A post', '2024-01-01T00:00:00.000Z');
    seedPost('postB', 'wsB', 'humanB', 'B post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const streamA = await openActivityStream(a, 'humanA', 'wsA');
    const streamB = await openActivityStream(a, 'humanB', 'wsB');
    try {
      await createCommentViaApi(a, 'postB', 'humanB', 'wsB', 'B-only update');
      const bEvent = await streamB.nextEvent();
      expect(bEvent.workspaceId).toBe('wsB');
      expect(bEvent.rootPostId).toBe('postB');

      await createCommentViaApi(a, 'postA', 'humanA', 'wsA', 'A-only update');
      const aEvent = await streamA.nextEvent();
      expect(aEvent.workspaceId).toBe('wsA');
      expect(aEvent.rootPostId).toBe('postA');
    } finally {
      await streamA.cancel();
      await streamB.cancel();
    }
  });

  it('closes the stream before future events after membership is suspended', async () => {
    twoWorkspaceFixture();
    domain.createActor({ id: 'humanA2', workspaceId: 'wsA', kind: 'human', displayName: 'Ava' });
    seedPost('postA', 'wsA', 'humanA2', 'A post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const stream = await openActivityStream(a, 'humanA', 'wsA');
    try {
      membership.suspendMembership('wsA', 'humanA');
      await createCommentViaApi(a, 'postA', 'humanA2', 'wsA', 'after suspension');
      await expect(stream.nextEventOrClosed()).resolves.toBeUndefined();
    } finally {
      await stream.cancel();
    }
  });

  it('closes the stream before future events after membership is removed', async () => {
    twoWorkspaceFixture();
    domain.createActor({ id: 'humanA2', workspaceId: 'wsA', kind: 'human', displayName: 'Ava' });
    seedPost('postA', 'wsA', 'humanA2', 'A post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const stream = await openActivityStream(a, 'humanA', 'wsA');
    try {
      expect(membership.removeMembership('wsA', 'humanA')).toBe(1);
      await createCommentViaApi(a, 'postA', 'humanA2', 'wsA', 'after removal');
      await expect(stream.nextEventOrClosed()).resolves.toBeUndefined();
    } finally {
      await stream.cancel();
    }
  });

  it('closes the stream before future events after the opening session is revoked', async () => {
    twoWorkspaceFixture();
    domain.createActor({ id: 'humanA2', workspaceId: 'wsA', kind: 'human', displayName: 'Ava' });
    seedPost('postA', 'wsA', 'humanA2', 'A post', '2024-01-01T00:00:00.000Z');
    const a = app();
    const session = auth.createSession({ actorId: 'humanA', workspaceId: 'wsA' });
    const stream = await openActivityStreamWithHeaders(a, {
      cookie: sessionCookie(session.secret),
    });
    try {
      expect(auth.revokeSession(session.secret)).toBe(1);
      await createCommentViaApi(a, 'postA', 'humanA2', 'wsA', 'after signout');
      await expect(stream.nextEventOrClosed()).resolves.toBeUndefined();
    } finally {
      await stream.cancel();
    }
  });
});
