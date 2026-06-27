// C2 post feed + C3 comment/reply + C7 agent control-plane API surface.

export {
  DEFAULT_FEED_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_FEED_LIMIT,
  PostNotFoundError,
  PostServiceImpl,
  type CommentTreeMeta,
  type FeedCursor,
  type FeedPage,
  type PostDTO,
  type PostService,
  type ReadPostResult,
} from './postService.js';
export { postRoutes, type PostRouteDeps } from './postRoutes.js';

export {
  CommentNotFoundError,
  CommentServiceImpl,
  DeletedParentError,
  type CommentDTO,
  type CommentService,
  type CommentTombstoneDTO,
  type CommentTreeNode,
  type CommentViewDTO,
  type FullThreadResult,
  type SubtreeResult,
} from './commentService.js';
export { commentRoutes, type CommentRouteDeps } from './commentRoutes.js';

export {
  AgentService,
  IDEMPOTENCY_HEADER,
  type AgentAuditEntry,
  type AgentServiceDeps,
  type AgentStatusPage,
  type AgentWriteResult,
  type PostStatusEntry,
} from './agentService.js';
export { agentRoutes, type AgentRouteDeps } from './agentRoutes.js';

export {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_EVENT_VERSION,
  ActivityEventHub,
  commentCreatedActivityEvent,
  isKnownActivityEventType,
  noopActivityEventPublisher,
  postCreatedActivityEvent,
  replyCreatedActivityEvent,
  serializeActivitySse,
  type ActivityCommentPayload,
  type ActivityEvent,
  type ActivityEventPublisher,
  type ActivityEventSource,
  type ActivityEventType,
  type ActivityPostPayload,
  type CommentCreatedActivityEvent,
  type PostCreatedActivityEvent,
  type ReplyCreatedActivityEvent,
} from './activityEvents.js';
export { activityRoutes, type ActivityRouteDeps } from './activityRoutes.js';
