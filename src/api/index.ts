// C2 post feed API surface.

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
