import { Hono } from 'hono';
import {
  CommentNotFoundError,
  DeletedParentError,
  PostNotFoundError as CommentPostNotFoundError,
  type CommentService,
  type CommentTreeNode,
  type CommentViewDTO,
} from '../api/commentService.js';
import {
  PostNotFoundError,
  type PostDTO,
  type PostService,
} from '../api/postService.js';
import {
  renderCommentContent,
  renderPostContent,
  type RenderableContent,
} from '../rendering/index.js';
import type { MembershipRepository } from '../security/membership.js';
import { AuthorizationError, type Principal } from '../security/types.js';
import {
  ACTOR_FIELD,
  ACTOR_HEADER_FIELD,
  escapeText,
  formField,
  resolveUiPrincipal,
  WORKSPACE_FIELD,
  WORKSPACE_HEADER_FIELD,
} from './shared.js';

/**
 * C5 — server-rendered post detail conversation UI.
 *
 * The detail page consumes C2 `readPost` for the post + comment counts and C3
 * `getFullThread` / create-comment / create-reply for the conversation tree.
 * All user-authored post/comment/reply content is adapted into the C3a renderer
 * before insertion into the document; only renderer-owned HTML is emitted.
 */

const COLLAPSE_DEPTH = 4;
const MAX_RENDER_DEPTH = 8;

export interface PostDetailRouteDeps {
  membership: MembershipRepository;
  postService: PostService;
  commentService: CommentService;
}

function isDeletedComment(
  node: CommentViewDTO,
): node is Extract<CommentViewDTO, { isDeleted: true }> {
  return 'isDeleted' in node && node.isDeleted === true;
}

function renderPostArticle(post: PostDTO): string {
  const renderable: RenderableContent = { content: post.content };
  const rendered = renderPostContent(renderable);
  return `    <article class="post-detail" data-post-id="${escapeText(post.id)}">
      <header class="post-meta">
        <span class="post-author">${escapeText(post.authorActorId)}</span>
        <time class="post-activity" datetime="${escapeText(post.lastActivityAt)}">${escapeText(post.lastActivityAt)}</time>
      </header>
      <div class="post-body">${rendered.html}</div>
    </article>`;
}

function renderPrincipalFields(principal: Principal): string {
  return `      <input type="hidden" name="${ACTOR_FIELD}" value="${escapeText(principal.actorId)}" />
      <input type="hidden" name="${WORKSPACE_FIELD}" value="${escapeText(principal.workspaceId)}" />`;
}

function renderCommentComposer(postId: string, principal: Principal): string {
  return `    <form class="comment-composer" method="post" action="/feed/${escapeText(postId)}/comments">
      <label for="new-comment">Add a comment</label>
      <textarea id="new-comment" name="content" required maxlength="4000" placeholder="Write a comment…"></textarea>
${renderPrincipalFields(principal)}
      <button type="submit">Comment</button>
    </form>`;
}

function renderReplyComposer(
  postId: string,
  parentId: string,
  parentAuthor: string,
  principal: Principal,
): string {
  const escapedParentId = escapeText(parentId);
  return `      <form class="reply-composer" method="post" action="/feed/${escapeText(postId)}/comments/${escapedParentId}/replies">
        <label for="reply-${escapedParentId}">Reply to ${escapeText(parentAuthor)}</label>
        <textarea id="reply-${escapedParentId}" name="content" required maxlength="4000" placeholder="Reply…"></textarea>
${renderPrincipalFields(principal)}
        <button type="submit">Reply</button>
      </form>`;
}

const HIDDEN_DESCENDANT_COUNT_LIMIT = 100;

function cappedDescendantCount(node: CommentTreeNode): { count: number; capped: boolean } {
  let count = 0;
  const pending = [...node.children];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    count += 1;
    if (count >= HIDDEN_DESCENDANT_COUNT_LIMIT) {
      return { count, capped: pending.length > 0 || next.children.length > 0 };
    }
    pending.push(...next.children);
  }
  return { count, capped: false };
}

function renderChildren(
  children: CommentTreeNode[],
  postId: string,
  principal: Principal,
  renderDepth: number,
): string {
  if (children.length === 0) return '';
  const rendered = children
    .map((child) => renderCommentNode(child, postId, principal, renderDepth + 1))
    .join('\n');
  if (renderDepth >= COLLAPSE_DEPTH) {
    return `      <details class="reply-branch" open>
        <summary>${children.length} nested ${children.length === 1 ? 'reply' : 'replies'}</summary>
        <ol class="reply-list">
${rendered}
        </ol>
      </details>`;
  }
  return `      <ol class="reply-list">
${rendered}
      </ol>`;
}

function renderCommentNode(
  tree: CommentTreeNode,
  postId: string,
  principal: Principal,
  renderDepth: number,
): string {
  const { node } = tree;
  const isReply = node.parentId !== null;
  const surface = isReply ? 'reply' : 'comment';
  const renderable: RenderableContent = isDeletedComment(node)
    ? { isDeleted: true }
    : { content: node.content };
  const rendered = renderCommentContent(renderable, surface);
  const author = isDeletedComment(node) ? 'deleted' : node.authorActorId;
  const replyTarget =
    !isDeletedComment(node) && node.replyToActorId !== null
      ? `        <p class="reply-target">Replying to <span>@${escapeText(node.replyToActorId)}</span></p>`
      : '';
  const replyForm = isDeletedComment(node)
    ? ''
    : renderReplyComposer(postId, node.id, node.authorActorId, principal);
  let children: string;
  if (renderDepth >= MAX_RENDER_DEPTH) {
    if (tree.children.length === 0) {
      children = '';
    } else {
      const hiddenDescendants = cappedDescendantCount(tree);
      const hiddenLabel = `${hiddenDescendants.count}${hiddenDescendants.capped ? '+' : ''}`;
      children = `      <p class="reply-depth-safeguard">${hiddenLabel} deeper ${hiddenDescendants.count === 1 && !hiddenDescendants.capped ? 'reply is' : 'replies are'} collapsed to keep this page readable.</p>`;
    }
  } else {
    children = renderChildren(tree.children, postId, principal, renderDepth);
  }
  const parentId = node.parentId === null ? '' : escapeText(node.parentId);
  return `        <li class="comment-node depth-${Math.min(renderDepth, MAX_RENDER_DEPTH)}" data-comment-id="${escapeText(node.id)}" data-parent-id="${parentId}">
      <article class="comment-card ${rendered.isTombstone ? 'is-tombstone' : ''}">
        <header class="comment-meta">
          <span class="comment-author">${escapeText(author)}</span>
          ${isDeletedComment(node) ? `<time datetime="${escapeText(node.deletedAt)}">deleted ${escapeText(node.deletedAt)}</time>` : `<time datetime="${escapeText(node.createdAt)}">${escapeText(node.createdAt)}</time>`}
        </header>
${replyTarget}
        <div class="comment-body">${rendered.html}</div>
${replyForm}
${children}
      </article>
    </li>`;
}

function renderConversation(
  comments: CommentTreeNode[],
  postId: string,
  principal: Principal,
): string {
  if (comments.length === 0) {
    return '    <p class="conversation-empty">No comments yet. Start the conversation.</p>';
  }
  return `    <ol class="comment-list">
${comments.map((comment) => renderCommentNode(comment, postId, principal, 0)).join('\n')}
    </ol>`;
}

function renderPostDetailDocument(input: {
  post: PostDTO;
  totalCount: number;
  firstLevelCount: number;
  comments: CommentTreeNode[];
  principal: Principal;
  error?: string | undefined;
  notice?: string | undefined;
}): string {
  const { post, totalCount, firstLevelCount, comments, principal } = input;
  const errorBlock = input.error
    ? `    <p class="conversation-error" role="alert">${escapeText(input.error)}</p>`
    : '';
  const noticeBlock = input.notice
    ? `    <p class="conversation-notice" role="status">${escapeText(input.notice)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conversation — Slack that Theo wants</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    header.page-header { border-bottom: 1px solid #ddd; padding-bottom: 1rem; margin-bottom: 1rem; }
    .back-link, .counts { color: #555; font-size: 0.9rem; }
    .post-detail, .comment-card { border: 1px solid #e1e1e1; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
    .post-meta, .comment-meta { display: flex; justify-content: space-between; color: #555; font-size: 0.85rem; margin-bottom: 0.5rem; gap: 1rem; }
    .post-body p:first-child, .comment-body p:first-child { margin-top: 0; }
    .post-body p:last-child, .comment-body p:last-child { margin-bottom: 0; }
    .comment-composer, .reply-composer { margin: 1rem 0; }
    textarea { width: 100%; min-height: 70px; box-sizing: border-box; padding: 0.5rem; font: inherit; }
    button { margin-top: 0.5rem; }
    .comment-list, .reply-list { list-style: none; padding-left: 0; }
    .reply-list, .reply-branch { margin-left: clamp(1rem, 4vw, 2rem); }
    .comment-node { margin: 0.75rem 0; }
    .reply-target { margin: 0 0 0.5rem; color: #555; font-size: 0.85rem; }
    .reply-target span { font-weight: 600; }
    .is-tombstone { color: #666; background: #fafafa; }
    .reply-depth-safeguard, .conversation-empty { color: #666; font-style: italic; }
    .conversation-error { color: #b00; }
    .conversation-notice { color: #060; }
  </style>
</head>
<body>
  <header class="page-header">
    <p class="back-link"><a href="/feed?${ACTOR_FIELD}=${encodeURIComponent(principal.actorId)}&amp;${WORKSPACE_FIELD}=${encodeURIComponent(principal.workspaceId)}">← Back to feed</a></p>
    <h1>Conversation</h1>
    <p class="principal">Signed in as <strong>${escapeText(principal.actorId)}</strong> in workspace <strong>${escapeText(principal.workspaceId)}</strong>.</p>
  </header>
${errorBlock}
${noticeBlock}
${renderPostArticle(post)}
  <section class="conversation" aria-live="polite">
    <h2>Comments</h2>
    <p class="counts">${totalCount} total ${totalCount === 1 ? 'comment/reply' : 'comments/replies'}; ${firstLevelCount} first-level ${firstLevelCount === 1 ? 'comment' : 'comments'}.</p>
${renderCommentComposer(post.id, principal)}
${renderConversation(comments, post.id, principal)}
  </section>
</body>
</html>`;
}

function renderErrorDocument(message: string, code: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conversation — error</title>
  <style>body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; } .conversation-error { color: #b00; }</style>
</head>
<body>
  <header class="page-header"><h1>Conversation</h1></header>
  <p class="conversation-error" role="alert">${escapeText(message)} (code: ${escapeText(code)})</p>
  <p>Provide <code>${ACTOR_HEADER_FIELD}</code> / <code>${WORKSPACE_HEADER_FIELD}</code> headers or <code>${ACTOR_FIELD}</code> / <code>${WORKSPACE_FIELD}</code> browser fields.</p>
</body>
</html>`;
}

function readFormParams(form: FormData | null): Record<string, string | undefined> {
  return {
    [ACTOR_FIELD]: formField(form, ACTOR_FIELD),
    [WORKSPACE_FIELD]: formField(form, WORKSPACE_FIELD),
    [ACTOR_HEADER_FIELD]: formField(form, ACTOR_HEADER_FIELD),
    [WORKSPACE_HEADER_FIELD]: formField(form, WORKSPACE_HEADER_FIELD),
  };
}

function renderCurrentState(input: {
  principal: Principal;
  postId: string;
  postService: PostService;
  commentService: CommentService;
  error?: string | undefined;
  notice?: string | undefined;
}): string {
  const read = input.postService.readPost({
    principal: input.principal,
    postId: input.postId,
  });
  const thread = input.commentService.getFullThread({
    principal: input.principal,
    postId: input.postId,
  });
  return renderPostDetailDocument({
    post: read.post,
    totalCount: read.comments.totalCount,
    firstLevelCount: read.comments.firstLevelCount,
    comments: thread.comments,
    principal: input.principal,
    error: input.error,
    notice: input.notice,
  });
}

function mapConversationError(err: unknown): {
  status: 401 | 403 | 404 | 409 | 500;
  code: string;
  message: string;
} {
  if (err instanceof AuthorizationError) {
    return { status: err.status as 401 | 403, code: err.code, message: err.message };
  }
  if (
    err instanceof PostNotFoundError ||
    err instanceof CommentPostNotFoundError ||
    err instanceof CommentNotFoundError
  ) {
    return { status: 404, code: 'not_found', message: err.message };
  }
  if (err instanceof DeletedParentError) {
    return { status: 409, code: 'deleted_parent', message: err.message };
  }
  return { status: 500, code: 'conversation_error', message: (err as Error).message };
}

export function postDetailRoutes(deps: PostDetailRouteDeps): Hono {
  const route = new Hono();
  const { membership, postService, commentService } = deps;

  route.get('/:postId', (c) => {
    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, {}, membership);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return c.html(
          renderErrorDocument(err.message, err.code),
          err.status as 401 | 403,
        );
      }
      throw err;
    }

    try {
      return c.html(
        renderCurrentState({
          principal,
          postId: c.req.param('postId'),
          postService,
          commentService,
        }),
      );
    } catch (err) {
      const mapped = mapConversationError(err);
      return c.html(
        renderErrorDocument(mapped.message, mapped.code),
        mapped.status,
      );
    }
  });

  route.post('/:postId/comments', async (c) => {
    const postId = c.req.param('postId');
    const form = await c.req.formData().catch(() => null);
    const content = formField(form, 'content');
    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, readFormParams(form), membership);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return c.html(
          renderErrorDocument(err.message, err.code),
          err.status as 401 | 403,
        );
      }
      throw err;
    }

    if (content === undefined || content.length === 0) {
      return c.html(
        renderCurrentState({
          principal,
          postId,
          postService,
          commentService,
          error: 'content must be a non-empty string',
        }),
        400,
      );
    }

    try {
      commentService.createComment({ principal, postId, content });
      return c.html(
        renderCurrentState({
          principal,
          postId,
          postService,
          commentService,
          notice: 'Comment added.',
        }),
        201,
      );
    } catch (err) {
      const mapped = mapConversationError(err);
      try {
        return c.html(
          renderCurrentState({
            principal,
            postId,
            postService,
            commentService,
            error: mapped.message,
          }),
          mapped.status,
        );
      } catch {
        return c.html(renderErrorDocument(mapped.message, mapped.code), mapped.status);
      }
    }
  });

  route.post('/:postId/comments/:commentId/replies', async (c) => {
    const postId = c.req.param('postId');
    const parentId = c.req.param('commentId');
    const form = await c.req.formData().catch(() => null);
    const content = formField(form, 'content');
    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, readFormParams(form), membership);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return c.html(
          renderErrorDocument(err.message, err.code),
          err.status as 401 | 403,
        );
      }
      throw err;
    }

    if (content === undefined || content.length === 0) {
      return c.html(
        renderCurrentState({
          principal,
          postId,
          postService,
          commentService,
          error: 'content must be a non-empty string',
        }),
        400,
      );
    }

    try {
      const parent = commentService.getComment({ principal, commentId: parentId });
      if (parent.rootPostId !== postId) {
        return c.html(
          renderCurrentState({
            principal,
            postId,
            postService,
            commentService,
            error: 'reply parent does not belong to this post',
          }),
          409,
        );
      }
      commentService.createReply({ principal, parentId, content });
      return c.html(
        renderCurrentState({
          principal,
          postId,
          postService,
          commentService,
          notice: 'Reply added.',
        }),
        201,
      );
    } catch (err) {
      const mapped = mapConversationError(err);
      try {
        return c.html(
          renderCurrentState({
            principal,
            postId,
            postService,
            commentService,
            error: mapped.message,
          }),
          mapped.status,
        );
      } catch {
        return c.html(renderErrorDocument(mapped.message, mapped.code), mapped.status);
      }
    }
  });

  return route;
}
