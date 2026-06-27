// C3a safe content rendering baseline, extended by C6 (code-block highlighting
// + copy affordance). This is the single source of safe rendering for
// post/comment/reply content. C4/C5 import from here and must never render raw
// stored content.

export { renderCommentContent, renderContent, renderPostContent } from './render.js';
export type { ContentSurface, RenderableContent, RenderedContent } from './render.js';
// C6 — dependency-free syntax highlighting tokens (used by the renderer; exported
// for tests and for UI that wants to assert on the fixed token-kind allowlist).
export {
  highlightGeneric,
  isTokenKind,
  isTsLike,
  tokenize,
  TOKEN_KINDS,
} from './highlight.js';
export type { HighlightToken, TokenKind } from './highlight.js';
