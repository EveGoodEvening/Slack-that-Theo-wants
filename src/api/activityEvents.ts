import { randomUUID } from 'node:crypto';
import {
  assertCanRead,
  principalScope,
  type Principal,
  workspaceScopePredicate,
} from '../security/index.js';

/**
 * C8 realtime activity event contract.
 *
 * The transport is intentionally actor-agnostic: human C2/C3 writes and C7
 * agent writes publish the same versioned event names from the shared services.
 * Events carry routing/metadata only (no user content), and subscribers fetch
 * server-rendered fragments or scoped API data after authorization.
 */

export const ACTIVITY_EVENT_VERSION = 1 as const;

export const ACTIVITY_EVENT_TYPES = {
  postCreated: 'slack.activity.post.created.v1',
  commentCreated: 'slack.activity.comment.created.v1',
  replyCreated: 'slack.activity.reply.created.v1',
} as const;

export type ActivityEventType =
  (typeof ACTIVITY_EVENT_TYPES)[keyof typeof ACTIVITY_EVENT_TYPES];

export interface ActivityPostPayload {
  id: string;
  workspaceId: string;
  authorActorId: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface ActivityCommentPayload {
  id: string;
  rootPostId: string;
  parentId: string | null;
  authorActorId: string;
  createdAt: string;
  replyToActorId: string | null;
}

interface ActivityEventBase {
  id: string;
  version: typeof ACTIVITY_EVENT_VERSION;
  type: ActivityEventType;
  workspaceId: string;
  /** The post whose feed position / detail conversation should refresh. */
  rootPostId: string;
  /** Current feed-ordering value after the producing write commits. */
  rootPostLastActivityAt: string;
  producedAt: string;
}

export interface PostCreatedActivityEvent extends ActivityEventBase {
  type: typeof ACTIVITY_EVENT_TYPES.postCreated;
  post: ActivityPostPayload;
}

export interface CommentCreatedActivityEvent extends ActivityEventBase {
  type: typeof ACTIVITY_EVENT_TYPES.commentCreated;
  comment: ActivityCommentPayload & { parentId: null; replyToActorId: null };
}

export interface ReplyCreatedActivityEvent extends ActivityEventBase {
  type: typeof ACTIVITY_EVENT_TYPES.replyCreated;
  comment: ActivityCommentPayload & { parentId: string };
}

export type ActivityEvent =
  | PostCreatedActivityEvent
  | CommentCreatedActivityEvent
  | ReplyCreatedActivityEvent;

export interface ActivityEventPublisher {
  publish(event: ActivityEvent): void;
}

export interface ActivityEventSource extends ActivityEventPublisher {
  subscribe(
    principal: Principal,
    listener: (event: ActivityEvent) => void,
  ): () => void;
}

export const noopActivityEventPublisher: ActivityEventPublisher = {
  publish: () => {},
};

export function isKnownActivityEventType(type: string): type is ActivityEventType {
  return (
    type === ACTIVITY_EVENT_TYPES.postCreated ||
    type === ACTIVITY_EVENT_TYPES.commentCreated ||
    type === ACTIVITY_EVENT_TYPES.replyCreated
  );
}

export function postCreatedActivityEvent(input: {
  post: ActivityPostPayload;
  id?: string;
  producedAt?: string;
}): PostCreatedActivityEvent {
  const producedAt = input.producedAt ?? new Date().toISOString();
  return {
    id:
      input.id ??
      eventId(ACTIVITY_EVENT_TYPES.postCreated, input.post.id, input.post.id, producedAt),
    version: ACTIVITY_EVENT_VERSION,
    type: ACTIVITY_EVENT_TYPES.postCreated,
    workspaceId: input.post.workspaceId,
    rootPostId: input.post.id,
    rootPostLastActivityAt: input.post.lastActivityAt,
    producedAt,
    post: {
      id: input.post.id,
      workspaceId: input.post.workspaceId,
      authorActorId: input.post.authorActorId,
      createdAt: input.post.createdAt,
      lastActivityAt: input.post.lastActivityAt,
    },
  };
}

export function commentCreatedActivityEvent(input: {
  workspaceId: string;
  rootPostLastActivityAt: string;
  comment: ActivityCommentPayload & { parentId: null; replyToActorId: null };
  id?: string;
  producedAt?: string;
}): CommentCreatedActivityEvent {
  const producedAt = input.producedAt ?? new Date().toISOString();
  return {
    id:
      input.id ??
      eventId(
        ACTIVITY_EVENT_TYPES.commentCreated,
        input.comment.rootPostId,
        input.comment.id,
        producedAt,
      ),
    version: ACTIVITY_EVENT_VERSION,
    type: ACTIVITY_EVENT_TYPES.commentCreated,
    workspaceId: input.workspaceId,
    rootPostId: input.comment.rootPostId,
    rootPostLastActivityAt: input.rootPostLastActivityAt,
    producedAt,
    comment: {
      id: input.comment.id,
      rootPostId: input.comment.rootPostId,
      parentId: null,
      authorActorId: input.comment.authorActorId,
      createdAt: input.comment.createdAt,
      replyToActorId: null,
    },
  };
}

export function replyCreatedActivityEvent(input: {
  workspaceId: string;
  rootPostLastActivityAt: string;
  comment: ActivityCommentPayload & { parentId: string };
  id?: string;
  producedAt?: string;
}): ReplyCreatedActivityEvent {
  const producedAt = input.producedAt ?? new Date().toISOString();
  return {
    id:
      input.id ??
      eventId(
        ACTIVITY_EVENT_TYPES.replyCreated,
        input.comment.rootPostId,
        input.comment.id,
        producedAt,
      ),
    version: ACTIVITY_EVENT_VERSION,
    type: ACTIVITY_EVENT_TYPES.replyCreated,
    workspaceId: input.workspaceId,
    rootPostId: input.comment.rootPostId,
    rootPostLastActivityAt: input.rootPostLastActivityAt,
    producedAt,
    comment: {
      id: input.comment.id,
      rootPostId: input.comment.rootPostId,
      parentId: input.comment.parentId,
      authorActorId: input.comment.authorActorId,
      createdAt: input.comment.createdAt,
      replyToActorId: input.comment.replyToActorId,
    },
  };
}

/** In-process fan-out hub. Durable state remains in C1; C8 events are hints. */
export class ActivityEventHub implements ActivityEventSource {
  private readonly subscribers = new Map<
    number,
    { principal: Principal; listener: (event: ActivityEvent) => void }
  >();
  private nextSubscriberId = 1;

  subscribe(
    principal: Principal,
    listener: (event: ActivityEvent) => void,
  ): () => void {
    assertCanRead(principal, principal.workspaceId);
    const id = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    this.subscribers.set(id, { principal, listener });
    return () => {
      this.subscribers.delete(id);
    };
  }

  publish(event: ActivityEvent): void {
    for (const subscription of this.subscribers.values()) {
      const inScope = workspaceScopePredicate(principalScope(subscription.principal));
      if (!inScope(event.workspaceId)) continue;
      try {
        subscription.listener(event);
      } catch {
        // A broken client must not break the write path or other subscribers.
      }
    }
  }
}

export function serializeActivitySse(event: ActivityEvent): string {
  return [
    `id: ${sanitizeSseField(event.id)}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}

function eventId(
  type: ActivityEventType,
  rootPostId: string,
  targetId: string,
  producedAt: string,
): string {
  return `${producedAt}:${type}:${rootPostId}:${targetId}:${randomUUID()}`;
}

function sanitizeSseField(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}
