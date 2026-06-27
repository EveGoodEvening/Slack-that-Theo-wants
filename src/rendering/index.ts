// C3a safe content rendering baseline.
//
// This is the single source of safe rendering for post/comment/reply content.
// C4/C5 import from here and must never render raw stored content.

export { renderCommentContent, renderContent, renderPostContent } from './render.js';
export type { ContentSurface, RenderedContent } from './render.js';
