import { CODE_BLOCK_CSS, COPY_CODE_SCRIPT, PREVIEW_SCRIPT } from './codeBlockUi.js';
import { Hono } from 'hono';
import { ACTIVITY_EVENT_TYPES } from '../api/activityEvents.js';
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
import type { AuthRepository } from '../security/auth.js';
import { AuthorizationError, type Principal } from '../security/types.js';
import {
  escapeText,
  formField,
  resolveUiPrincipal,
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
  auth: AuthRepository;
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
  const articleLabel = `Post by ${post.authorActorId}; last activity ${post.lastActivityAt}`;
  return `    <article class="post-detail" data-post-id="${escapeText(post.id)}" aria-label="${escapeText(articleLabel)}">
      <header class="post-meta">
        <span class="post-author">${escapeText(post.authorActorId)}</span>
        <time class="post-activity" datetime="${escapeText(post.lastActivityAt)}">${escapeText(post.lastActivityAt)}</time>
      </header>
      <div class="post-body">${rendered.html}</div>
    </article>`;
}


function renderCommentComposer(postId: string): string {
  return `    <form class="comment-composer" method="post" action="/feed/${escapeText(postId)}/comments" aria-describedby="new-comment-help new-comment-status">
      <label for="new-comment">Add a comment</label>
      <p id="new-comment-help" class="form-help">Comments support Markdown-style text and fenced code blocks.</p>
      <textarea id="new-comment" name="content" required maxlength="4000" placeholder="Write a comment…" aria-describedby="new-comment-help new-comment-status"></textarea>
      <button type="submit">Comment</button>
      <button type="button" class="preview-toggle" data-preview-for="new-comment" aria-controls="new-comment-preview" aria-pressed="false">Preview</button>
      <div id="new-comment-preview" class="composer-preview" data-preview-for="new-comment" role="status" aria-live="polite" aria-atomic="true"></div>
      <p id="new-comment-status" class="form-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </form>`;
}

function renderReplyComposer(
  postId: string,
  parentId: string,
  parentAuthor: string,
): string {
  const escapedParentId = escapeText(parentId);
  const replyTextareaId = `reply-${escapedParentId}`;
  const replyHelpId = `reply-help-${escapedParentId}`;
  const replyStatusId = `reply-status-${escapedParentId}`;
  const replyPreviewId = `reply-preview-${escapedParentId}`;
  return `      <form class="reply-composer" method="post" action="/feed/${escapeText(postId)}/comments/${escapedParentId}/replies" aria-describedby="${replyHelpId} ${replyStatusId}">
        <label for="${replyTextareaId}">Reply to ${escapeText(parentAuthor)}</label>
        <p id="${replyHelpId}" class="form-help">Replies stay nested under this comment.</p>
        <textarea id="${replyTextareaId}" name="content" required maxlength="4000" placeholder="Reply…" aria-describedby="${replyHelpId} ${replyStatusId}"></textarea>
        <button type="submit">Reply</button>
        <button type="button" class="preview-toggle" data-preview-for="${replyTextareaId}" aria-controls="${replyPreviewId}" aria-pressed="false">Preview</button>
        <div id="${replyPreviewId}" class="composer-preview" data-preview-for="${replyTextareaId}" role="status" aria-live="polite" aria-atomic="true"></div>
        <p id="${replyStatusId}" class="form-status" role="status" aria-live="polite" aria-atomic="true"></p>
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
  renderDepth: number,
): string {
  if (children.length === 0) return '';
  const rendered = children
    .map((child) => renderCommentNode(child, postId, renderDepth + 1))
    .join('\n');
  if (renderDepth >= COLLAPSE_DEPTH) {
    return `      <details class="reply-branch" open>
        <summary>${children.length} nested ${children.length === 1 ? 'reply' : 'replies'}</summary>
        <ol class="reply-list" aria-label="Nested replies">
${rendered}
        </ol>
      </details>`;
  }
  return `      <ol class="reply-list" aria-label="Replies">
${rendered}
      </ol>`;
}

function renderCommentNode(
  tree: CommentTreeNode,
  postId: string,
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
  const commentLabel = `${surface === 'reply' ? 'Reply' : 'Comment'} by ${author}`;
  const replyTarget =
    !isDeletedComment(node) && node.replyToActorId !== null
      ? `        <p class="reply-target">Replying to <span>@${escapeText(node.replyToActorId)}</span></p>`
      : '';
  const replyForm = isDeletedComment(node)
    ? ''
    : renderReplyComposer(postId, node.id, node.authorActorId);
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
    children = renderChildren(tree.children, postId, renderDepth);
  }
  const parentId = node.parentId === null ? '' : escapeText(node.parentId);
  return `        <li class="comment-node depth-${Math.min(renderDepth, MAX_RENDER_DEPTH)}" data-comment-id="${escapeText(node.id)}" data-parent-id="${parentId}">
      <article class="comment-card ${rendered.isTombstone ? 'is-tombstone' : ''}" aria-label="${escapeText(commentLabel)}">
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
): string {
  if (comments.length === 0) {
    return '    <p class="conversation-empty" role="status">No comments yet. Start the conversation.</p>';
  }
  return `    <ol class="comment-list" aria-label="Comments">
${comments.map((comment) => renderCommentNode(comment, postId, 0)).join('\n')}
    </ol>`;
}


function renderConversationSection(input: {
  post: PostDTO;
  totalCount: number;
  firstLevelCount: number;
  comments: CommentTreeNode[];
}): string {
  const { post, totalCount, firstLevelCount, comments } = input;
  return `  <section class="conversation" aria-labelledby="comments-heading" aria-describedby="conversation-counts" aria-live="polite" aria-busy="false">
    <h2 id="comments-heading">Comments</h2>
    <p id="conversation-counts" class="counts">${totalCount} total ${totalCount === 1 ? 'comment/reply' : 'comments/replies'}; ${firstLevelCount} first-level ${firstLevelCount === 1 ? 'comment' : 'comments'}.</p>
${renderCommentComposer(post.id)}
${renderConversation(comments, post.id)}
    <p class="conversation-realtime-status" data-realtime-status="idle" role="status" aria-live="polite" aria-atomic="true">Live comment updates stream when this browser supports EventSource.</p>
  </section>`;
}

function renderPostDetailRealtimeScript(postId: string): string {
  const eventUrl = '/events';
  const fragmentUrl = `/feed/${encodeURIComponent(postId)}/fragments/conversation`;
  const eventTypes = JSON.stringify([
    ACTIVITY_EVENT_TYPES.commentCreated,
    ACTIVITY_EVENT_TYPES.replyCreated,
  ]);
  return `    // C8 progressive enhancement: refresh this conversation on scoped activity.
    (function () {
      if (typeof EventSource === 'undefined') return;
      var source = new EventSource(${JSON.stringify(eventUrl)});
      var postId = ${JSON.stringify(postId)};
      var eventTypes = ${eventTypes};
      var latestRefreshToken = 0;
      var latestActivityAt = null;
      function eventActivityAt(payload) {
        if (payload && typeof payload.rootPostLastActivityAt === 'string') return payload.rootPostLastActivityAt;
        return null;
      }
      function composerTextareas(root) {
        if (!root || !root.querySelectorAll) return [];
        return Array.prototype.slice.call(root.querySelectorAll('textarea'));
      }
      function composerForm(textarea) {
        return textarea && textarea.closest ? textarea.closest('form') : null;
      }
      function isConversationComposer(form) {
        var classes = ' ' + ((form && form.getAttribute('class')) || '') + ' ';
        return classes.indexOf(' comment-composer ') >= 0 || classes.indexOf(' reply-composer ') >= 0;
      }
      function composerKey(textarea) {
        if (!textarea || textarea.getAttribute('name') !== 'content') return null;
        var form = composerForm(textarea);
        if (!form || !isConversationComposer(form)) return null;
        var id = textarea.getAttribute('id');
        if (id) return 'id:' + id;
        var action = form.getAttribute('action');
        return action ? 'action:' + action : null;
      }
      function captureComposers(current) {
        var captured = Object.create(null);
        var active = document.activeElement || null;
        composerTextareas(current).forEach(function (textarea) {
          var key = composerKey(textarea);
          if (!key) return;
          var form = composerForm(textarea);
          if (!form) return;
          captured[key] = {
            form: form,
            textarea: textarea,
            value: typeof textarea.value === 'string' ? textarea.value : '',
            wasFocused: textarea === active,
            selectionStart: typeof textarea.selectionStart === 'number' ? textarea.selectionStart : null,
            selectionEnd: typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : null,
            selectionDirection: typeof textarea.selectionDirection === 'string' ? textarea.selectionDirection : 'none'
          };
        });
        return captured;
      }
      function moveCapturedComposers(next, captured) {
        var activeState = null;
        composerTextareas(next).forEach(function (textarea) {
          var key = composerKey(textarea);
          var state = key ? captured[key] : null;
          if (!state) return;
          var nextForm = composerForm(textarea);
          if (!nextForm) return;
          state.textarea.value = state.value;
          if (nextForm !== state.form) nextForm.replaceWith(state.form);
          if (state.wasFocused) activeState = state;
        });
        return activeState;
      }
      function restoreComposerFocus(state) {
        if (!state || !state.textarea || typeof state.textarea.focus !== 'function') return;
        state.textarea.focus();
        if (
          typeof state.textarea.setSelectionRange === 'function' &&
          state.selectionStart !== null &&
          state.selectionEnd !== null
        ) {
          try {
            state.textarea.setSelectionRange(
              state.selectionStart,
              state.selectionEnd,
              state.selectionDirection || 'none',
            );
          } catch (_) {}
        }
      }
      function refreshConversation(message) {
        var payload;
        try { payload = JSON.parse(message.data); } catch (_) { return; }
        if (!payload || payload.rootPostId !== postId) return;
        var activityAt = eventActivityAt(payload);
        if (activityAt && latestActivityAt && activityAt < latestActivityAt) return;
        if (activityAt && (!latestActivityAt || activityAt > latestActivityAt)) latestActivityAt = activityAt;
        var refreshToken = ++latestRefreshToken;
        var refreshActivityAt = activityAt || latestActivityAt;
        fetch(${JSON.stringify(fragmentUrl)}, { headers: { Accept: 'text/html' } })
          .then(function (response) {
            if (!response.ok) throw new Error('conversation fragment fetch failed');
            return response.text();
          })
          .then(function (html) {
            if (refreshToken !== latestRefreshToken) return;
            if (refreshActivityAt && latestActivityAt && refreshActivityAt < latestActivityAt) return;
            var template = document.createElement('template');
            template.innerHTML = html.trim();
            var next = template.content.firstElementChild;
            var current = document.querySelector('.conversation');
            if (next && current) {
              var activeComposer = moveCapturedComposers(next, captureComposers(current));
              current.replaceWith(next);
              restoreComposerFocus(activeComposer);
            }
          })
          .catch(function () {
            if (refreshToken !== latestRefreshToken) return;
            var status = document.querySelector('[data-realtime-status]');
            if (status) status.textContent = 'Live updates paused; refresh to catch up.';
          });
      }
      eventTypes.forEach(function (type) { source.addEventListener(type, refreshConversation); });
      source.addEventListener('open', function () {
        var status = document.querySelector('[data-realtime-status]');
        if (status) status.textContent = 'Live updates connected.';
      });
      source.addEventListener('error', function () {
        var status = document.querySelector('[data-realtime-status]');
        if (status) status.textContent = 'Live updates reconnecting…';
      });
    })();`;
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
    ? `    <p class="conversation-error" role="alert" aria-live="assertive">${escapeText(input.error)}</p>`
    : '';
  const noticeBlock = input.notice
    ? `    <p class="conversation-notice" role="status" aria-live="polite" aria-atomic="true">${escapeText(input.notice)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Conversation — Slack that Theo wants</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    .skip-link { position: absolute; left: -999px; top: 0; padding: 0.5rem 0.75rem; background: #fff; border: 1px solid #111; border-radius: 4px; }
    .skip-link:focus { left: 1rem; top: 1rem; z-index: 1000; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    header.page-header { border-bottom: 1px solid #ddd; padding-bottom: 1rem; margin-bottom: 1rem; }
    .back-link, .counts { color: #555; font-size: 0.9rem; }
    .post-detail, .comment-card { border: 1px solid #e1e1e1; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
    .post-meta, .comment-meta { display: flex; justify-content: space-between; color: #555; font-size: 0.85rem; margin-bottom: 0.5rem; gap: 1rem; }
    .post-body p:first-child, .comment-body p:first-child { margin-top: 0; }
    .post-body p:last-child, .comment-body p:last-child { margin-bottom: 0; }
    .comment-composer, .reply-composer { margin: 1rem 0; }
    textarea { width: 100%; min-height: 70px; box-sizing: border-box; padding: 0.5rem; font: inherit; }
    button { margin-top: 0.5rem; }
    .form-help, .form-status { color: #555; font-size: 0.85rem; margin: 0.25rem 0 0.5rem; }
    .comment-list, .reply-list { list-style: none; padding-left: 0; }
    .reply-list, .reply-branch { margin-left: clamp(1rem, 4vw, 2rem); }
    .comment-node { margin: 0.75rem 0; }
    .reply-target { margin: 0 0 0.5rem; color: #555; font-size: 0.85rem; }
    .reply-target span { font-weight: 600; }
    .is-tombstone { color: #666; background: #fafafa; }
    .reply-depth-safeguard, .conversation-empty { color: #666; font-style: italic; }
    .conversation-error { color: #b00; }
    .conversation-notice { color: #060; }
    .conversation-realtime-status { color: #666; font-size: 0.85rem; }
${CODE_BLOCK_CSS}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="page-header">
    <nav class="back-link" aria-label="Post detail navigation"><a href="/feed">← Back to feed</a></nav>
    <h1>Conversation</h1>
    <p class="principal">Signed in as <strong>${escapeText(principal.actorId)}</strong> in workspace <strong>${escapeText(principal.workspaceId)}</strong>.</p>
  </header>
  <main id="main-content" tabindex="-1">
${errorBlock}
${noticeBlock}
${renderPostArticle(post)}
${renderConversationSection({
    post,
    totalCount,
    firstLevelCount,
    comments,
  })}
  </main>
  <script>
${renderPostDetailRealtimeScript(post.id)}
${COPY_CODE_SCRIPT}
${PREVIEW_SCRIPT}
  </script>
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
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    .skip-link { position: absolute; left: -999px; top: 0; padding: 0.5rem 0.75rem; background: #fff; border: 1px solid #111; border-radius: 4px; }
    .skip-link:focus { left: 1rem; top: 1rem; }
    .conversation-error { color: #b00; }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="page-header"><h1>Conversation</h1></header>
  <main id="main-content" tabindex="-1">
    <p class="conversation-error" role="alert" aria-live="assertive">${escapeText(message)} (code: ${escapeText(code)})</p>
    <p><a href="/feed">Back to feed</a></p>
  </main>
</body>
</html>`;
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

function renderConversationFragment(input: {
  principal: Principal;
  postId: string;
  postService: PostService;
  commentService: CommentService;
}): string {
  const read = input.postService.readPost({
    principal: input.principal,
    postId: input.postId,
  });
  const thread = input.commentService.getFullThread({
    principal: input.principal,
    postId: input.postId,
  });
  return renderConversationSection({
    post: read.post,
    totalCount: read.comments.totalCount,
    firstLevelCount: read.comments.firstLevelCount,
    comments: thread.comments,
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
  const { auth, membership, postService, commentService } = deps;

  route.get('/:postId/fragments/conversation', (c) => {
    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, membership, auth);
      return c.html(
        renderConversationFragment({
          principal,
          postId: c.req.param('postId'),
          postService,
          commentService,
        }),
      );
    } catch (err) {
      const mapped = mapConversationError(err);
      return c.text(mapped.message, mapped.status);
    }
  });

  route.get('/:postId', (c) => {
    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, membership, auth);
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
      principal = resolveUiPrincipal(c.req, membership, auth);
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
      try {
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
      } catch (err) {
        const mapped = mapConversationError(err);
        return c.html(renderErrorDocument(mapped.message, mapped.code), mapped.status);
      }
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
            error: `${mapped.code}: ${mapped.message}`,
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
      principal = resolveUiPrincipal(c.req, membership, auth);
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
      try {
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
      } catch (err) {
        const mapped = mapConversationError(err);
        return c.html(renderErrorDocument(mapped.message, mapped.code), mapped.status);
      }
    }

    try {
      const parent = commentService.getComment({ principal, commentId: parentId });
      if (parent.rootPostId !== postId) {
        try {
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
        } catch (err) {
          const mapped = mapConversationError(err);
          return c.html(renderErrorDocument(mapped.message, mapped.code), mapped.status);
        }
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
            error: `${mapped.code}: ${mapped.message}`,
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
