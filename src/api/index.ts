// C2 post feed + C3 comment/reply API surface.

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
