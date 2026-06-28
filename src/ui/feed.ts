import { CODE_BLOCK_CSS, COPY_CODE_SCRIPT, PREVIEW_SCRIPT } from './codeBlockUi.js';
import { Hono } from 'hono';
import type { MembershipRepository } from '../security/membership.js';
import type { AuthRepository } from '../security/auth.js';
import { AuthorizationError, type Principal } from '../security/types.js';
import {
  renderContent,
  renderPostContent,
  type RenderableContent,
} from '../rendering/index.js';
import { ACTIVITY_EVENT_TYPES } from '../api/activityEvents.js';
import { PostNotFoundError, type PostDTO, type PostService } from '../api/postService.js';
import {
  escapeText,
  resolveUiPrincipal,
} from './shared.js';

/**
 * C4 — Minimal human UI: feed and post creation.
 *
 * Server-rendered HTML over the C2 post feed service. The feed view lists posts
 * in the exact order the C2 `listFeed` endpoint returns them (no client-side
 * re-sort), and every post body is rendered through the C3a `renderPostContent`
 * sanitizer — raw stored content is never emitted. A create-post form posts
 * back to this route and calls the C2 `createPost` service, then re-renders the
 * feed so the new post appears at the top. Each post card links to its C5 post
 * detail view at `/feed/:postId` where the conversation (comments + nested
 * replies) lives.
 *
 * Principal resolution uses the C9 local sign-in session via the shared
 * `resolveUiPrincipal` helper (see `./shared.ts`). Browser forms do not carry
 * actor/workspace ids; the HttpOnly session cookie selects the current
 * workspace/group and the service layer performs the per-resource checks.
 *
 * States:
 * - empty: the feed has no posts for the principal's workspace.
 * - error: principal resolution failed (401/403) or the feed read threw.
 * - loading: a progressive-enhancement indicator shown while the create-post
 *   form is submitting (noscript fallback submits normally).
 */

export interface FeedRouteDeps {
  membership: MembershipRepository;
  auth: AuthRepository;
  service: PostService;
}

/** Render a single post card. Body content goes through C3a renderPostContent. */
function renderPostCard(post: PostDTO): string {
  // The feed endpoint only returns live posts (tombstones are excluded by the
  // C2 service), so we always have content here. We still route through
  // renderPostContent so a tombstone input would render safely if the contract
  // ever changes.
  const renderable: RenderableContent = { content: post.content };
  const rendered = renderPostContent(renderable);
  const conversationHref = `/feed/${encodeURIComponent(post.id)}`;
  const cardLabel = `Post by ${post.authorActorId}; last activity ${post.lastActivityAt}`;
  return `    <article class="post-card" data-post-id="${escapeText(post.id)}" data-last-activity-at="${escapeText(post.lastActivityAt)}" aria-label="${escapeText(cardLabel)}">
      <header class="post-meta">
        <span class="post-author">${escapeText(post.authorActorId)}</span>
        <time class="post-activity" datetime="${escapeText(post.lastActivityAt)}">${escapeText(post.lastActivityAt)}</time>
      </header>
      <div class="post-body">${rendered.html}</div>
      <p class="post-link"><a href="${escapeText(conversationHref)}" aria-label="${escapeText(`View conversation for post by ${post.authorActorId}`)}">View conversation</a></p>
    </article>`;
}


function renderFeedRealtimeScript(): string {
  const eventUrl = '/events';
  const eventTypes = JSON.stringify([
    ACTIVITY_EVENT_TYPES.postCreated,
    ACTIVITY_EVENT_TYPES.commentCreated,
    ACTIVITY_EVENT_TYPES.replyCreated,
  ]);
  return `    // C8 progressive enhancement: subscribe to scoped SSE activity.
    (function () {
      if (typeof EventSource === 'undefined') return;
      var feed = document.getElementById('feed');
      if (!feed) return;
      var status = document.querySelector('[data-realtime-status]');
      var source = new EventSource(${JSON.stringify(eventUrl)});
      var eventTypes = ${eventTypes};
      function escapedSelector(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/["\\\\]/g, '\\\\$&');
      }
      function rootPostId(payload) {
        if (payload && typeof payload.rootPostId === 'string') return payload.rootPostId;
        if (payload && payload.post && typeof payload.post.id === 'string') return payload.post.id;
        return null;
      }
      function eventActivityAt(payload) {
        if (payload && typeof payload.rootPostLastActivityAt === 'string') return payload.rootPostLastActivityAt;
        if (payload && payload.post && typeof payload.post.lastActivityAt === 'string') return payload.post.lastActivityAt;
        return null;
      }
      function cardPostId(card) {
        if (!card || typeof card.getAttribute !== 'function') return null;
        var id = card.getAttribute('data-post-id');
        return typeof id === 'string' && id.length > 0 ? id : null;
      }
      function cardActivityAt(card) {
        if (!card || typeof card.getAttribute !== 'function') return null;
        var activityAt = card.getAttribute('data-last-activity-at');
        if (activityAt) return activityAt;
        var time = typeof card.querySelector === 'function' ? card.querySelector('time.post-activity') : null;
        if (!time || typeof time.getAttribute !== 'function') return null;
        activityAt = time.getAttribute('datetime');
        return activityAt || null;
      }
      function shouldInsertBefore(activityAt, postId, current) {
        var currentActivityAt = cardActivityAt(current);
        if (!activityAt || !currentActivityAt) return false;
        if (activityAt > currentActivityAt) return true;
        if (activityAt < currentActivityAt) return false;
        var currentPostId = cardPostId(current);
        return !!postId && !!currentPostId && postId > currentPostId;
      }
      function insertCardByActivity(card, activityAt, postId) {
        if (!activityAt) {
          feed.prepend(card);
          return;
        }
        for (var i = 0; i < feed.children.length; i += 1) {
          var current = feed.children[i];
          if (!current || cardPostId(current) === null) continue;
          if (shouldInsertBefore(activityAt, postId, current)) {
            feed.insertBefore(card, current);
            return;
          }
        }
        feed.appendChild(card);
      }
      function upsertPostCard(message) {
        var payload;
        try { payload = JSON.parse(message.data); } catch (_) { return; }
        var postId = rootPostId(payload);
        if (!postId) return;
        fetch(${JSON.stringify('/feed/fragments/posts/')} + encodeURIComponent(postId), { headers: { Accept: 'text/html' } })
          .then(function (response) {
            if (!response.ok) throw new Error('post fragment fetch failed');
            return response.text();
          })
          .then(function (html) {
            var template = document.createElement('template');
            template.innerHTML = html.trim();
            var card = template.content.firstElementChild;
            if (!card) return;
            var activityAt = cardActivityAt(card) || eventActivityAt(payload);
            var existing = feed.querySelector('[data-post-id="' + escapedSelector(postId) + '"]');
            if (existing) {
              var existingActivityAt = cardActivityAt(existing);
              if (existingActivityAt && activityAt && existingActivityAt > activityAt) return;
              existing.remove();
            }
            var empty = feed.querySelector('.feed-empty');
            if (empty) empty.remove();
            insertCardByActivity(card, activityAt, postId);
            if (status) status.textContent = 'Live updates connected.';
          })
          .catch(function () {
            if (status) status.textContent = 'Live updates paused; refresh to catch up.';
          });
      }
      eventTypes.forEach(function (type) { source.addEventListener(type, upsertPostCard); });
      source.addEventListener('open', function () {
        if (status) status.textContent = 'Live updates connected.';
      });
      source.addEventListener('error', function () {
        if (status) status.textContent = 'Live updates reconnecting…';
      });
    })();`;
}

/** Render the full feed HTML document. */
function renderFeedDocument(
  posts: PostDTO[],
  principal: Principal,
  opts: { error?: string | undefined; notice?: string | undefined } = {},
): string {
  const cards = posts.map((post) => renderPostCard(post)).join('\n');
  const body =
    posts.length === 0
      ? '    <p class="feed-empty">No posts yet. Create the first one above.</p>'
      : cards;

  const errorBlock = opts.error
    ? `    <p class="feed-error" role="alert" aria-live="assertive">${escapeText(opts.error)}</p>`
    : '';
  const noticeBlock = opts.notice
    ? `    <p class="feed-notice" role="status" aria-live="polite" aria-atomic="true">${escapeText(opts.notice)}</p>`
    : '';

  // The create-post form posts only the untrusted content; the C9 session
  // cookie supplies the current actor/workspace.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Feed — Slack that Theo wants</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    .skip-link { position: absolute; left: -999px; top: 0; padding: 0.5rem 0.75rem; background: #fff; border: 1px solid #111; border-radius: 4px; }
    .skip-link:focus { left: 1rem; top: 1rem; z-index: 1000; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    header.page-header { border-bottom: 1px solid #ddd; padding-bottom: 1rem; margin-bottom: 1rem; }
    form.create-post { margin-bottom: 2rem; }
    form.create-post textarea { width: 100%; min-height: 80px; box-sizing: border-box; padding: 0.5rem; font: inherit; }
    form.create-post button { margin-top: 0.5rem; }
    .form-help, .form-status { color: #555; font-size: 0.85rem; margin: 0.25rem 0 0.5rem; }
    .post-card { border: 1px solid #e1e1e1; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
    .post-meta { display: flex; justify-content: space-between; color: #555; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .post-body p:first-child { margin-top: 0; }
    .post-body p:last-child { margin-bottom: 0; }
    .post-link { margin: 0.5rem 0 0; font-size: 0.85rem; }
    .feed-empty { color: #666; font-style: italic; }
    .feed-error { color: #b00; }
    .feed-notice { color: #060; }
    .feed-realtime-status { color: #666; font-size: 0.85rem; }
    .is-loading { opacity: 0.6; }
${CODE_BLOCK_CSS}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="page-header">
    <h1>Feed</h1>
    <p class="principal">Signed in as <strong>${escapeText(principal.actorId)}</strong> in workspace <strong>${escapeText(principal.workspaceId)}</strong>.</p>
  </header>
  <main id="main-content" tabindex="-1">
${errorBlock}
${noticeBlock}
  <form class="create-post" method="post" action="/feed" id="create-post-form" aria-describedby="create-post-help create-post-status">
    <label for="content">Create a post</label>
    <p id="create-post-help" class="form-help">Markdown-style text and fenced code blocks are supported.</p>
    <textarea id="content" name="content" required maxlength="4000" placeholder="Write something…" aria-describedby="create-post-help create-post-status"></textarea>
    <button type="submit">Post</button>
    <button type="button" class="preview-toggle" data-preview-for="content" aria-controls="create-post-preview" aria-pressed="false">Preview</button>
    <div id="create-post-preview" class="composer-preview" data-preview-for="content" role="status" aria-live="polite" aria-atomic="true"></div>
    <p id="create-post-status" class="form-status" role="status" aria-live="polite" aria-atomic="true"></p>
    <noscript><p class="feed-loading">Submitting…</p></noscript>
  </form>
  <section class="feed" id="feed" aria-labelledby="feed-heading" aria-live="polite" aria-busy="false">
    <h2 id="feed-heading" class="sr-only">Posts</h2>
${body}
  </section>
  <p class="feed-realtime-status" data-realtime-status="idle" role="status" aria-live="polite" aria-atomic="true">Live updates stream when this browser supports EventSource.</p>
  </main>
  <script>
    // Progressive enhancement: show a loading indicator on submit without
    // blocking the noscript fallback. Server-rendered content is already
    // present, so this only covers the create-post round-trip.
    (function () {
      var form = document.getElementById('create-post-form');
      if (!form) return;
      form.addEventListener('submit', function () {
        form.classList.add('is-loading');
        var feed = document.getElementById('feed');
        if (feed) feed.setAttribute('aria-busy', 'true');
        var formStatus = document.getElementById('create-post-status');
        if (formStatus) formStatus.textContent = 'Submitting post…';
      });
    })();
${renderFeedRealtimeScript()}
${COPY_CODE_SCRIPT}
${PREVIEW_SCRIPT}
  </script>
</body>
</html>`;
}

/** Render an error-only page when principal resolution fails. */
function renderErrorDocument(message: string, code: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Feed — error</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    .skip-link { position: absolute; left: -999px; top: 0; padding: 0.5rem 0.75rem; background: #fff; border: 1px solid #111; border-radius: 4px; }
    .skip-link:focus { left: 1rem; top: 1rem; }
    .feed-error { color: #b00; }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="page-header"><h1>Feed</h1></header>
  <main id="main-content" tabindex="-1">
    <p class="feed-error" role="alert" aria-live="assertive">${escapeText(message)} (code: ${escapeText(code)})</p>
    <p><a href="/auth/signin">Sign in</a> to choose a workspace/group, or ask for access if this is a permission error.</p>
  </main>
</body>
</html>`;
}

export function feedRoutes(deps: FeedRouteDeps): Hono {
  const route = new Hono();
  const { auth, membership, service } = deps;

  // GET /feed — landing/feed view consuming the C2 list-feed service.
  route.get('/', (c) => {
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

    let posts: PostDTO[] = [];
    let errorMessage: string | undefined;
    try {
      const page = service.listFeed({ principal });
      // Render in API response order — do NOT re-sort client-side.
      posts = page.posts;
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    if (errorMessage) {
      return c.html(
        renderFeedDocument([], principal, { error: errorMessage }),
        500,
      );
    }
    return c.html(renderFeedDocument(posts, principal));
  });

  // GET /feed/fragments/posts/:postId — server-rendered card for C8 live upsert.
  route.get('/fragments/posts/:postId', (c) => {
    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, membership, auth);
      const read = service.readPost({
        principal,
        postId: c.req.param('postId'),
      });
      return c.html(renderPostCard(read.post));
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return c.text(`${err.code}: ${err.message}`, err.status as 401 | 403);
      }
      if (err instanceof PostNotFoundError) {
        return c.text(err.message, 404);
      }
      throw err;
    }
  });

  // POST /feed — create-post form calling the C2 create endpoint service.
  route.post('/', async (c) => {
    // The principal is resolved from the sign-in session cookie.
    const form = await c.req.formData().catch(() => null);
    const content = form?.get('content');


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

    if (typeof content !== 'string' || content.length === 0) {
      // Re-render the feed with an error, preserving the empty form.
      let posts: PostDTO[] = [];
      try {
        posts = service.listFeed({ principal }).posts;
      } catch {
        // ignore feed read error here; the create error is primary
      }
      return c.html(
        renderFeedDocument(posts, principal, {
          error: 'content must be a non-empty string',
        }),
        400,
      );
    }

    try {
      service.createPost({ principal, content });
    } catch (err) {
      let posts: PostDTO[] = [];
      try {
        posts = service.listFeed({ principal }).posts;
      } catch {
        // ignore
      }
      if (err instanceof AuthorizationError) {
        return c.html(
          renderFeedDocument(posts, principal, {
            error: `${err.code}: ${err.message}`,
          }),
          err.status as 401 | 403,
        );
      }
      return c.html(
        renderFeedDocument(posts, principal, {
          error: (err as Error).message,
        }),
        500,
      );
    }

    // Re-render the feed so the new post appears at the top (C2 order).
    let posts: PostDTO[] = [];
    try {
      posts = service.listFeed({ principal }).posts;
    } catch (err) {
      return c.html(
        renderFeedDocument([], principal, { error: (err as Error).message }),
        500,
      );
    }
    return c.html(
      renderFeedDocument(posts, principal, { notice: 'Post created.' }),
      201,
    );
  });

  // POST /feed/preview — C6 authoring preview. Renders the raw composer text
  // through the same C3a sanitizing renderer as live content and returns the
  // safe HTML fragment. The composer preview toggle POSTs here; the response
  // is inserted into a preview pane. No stored content is touched, so this is
  // a pure render of untrusted input — sanitization is identical to live
  // posts. Principal resolution is required to keep the surface consistent
  // with the C1a authorization baseline.
  route.post('/preview', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const content = form?.get('content');
    // Resolve the same C9 principal as a live submit; the value is only
    // needed for the authorization gate (preview touches no stored data).
    try {
      resolveUiPrincipal(c.req, membership, auth);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return c.html(
          `<p class="feed-error" role="alert" aria-live="assertive">${escapeText(err.message)} (code: ${escapeText(err.code)})</p>`,
          err.status as 401 | 403,
        );
      }
      throw err;
    }
    if (typeof content !== 'string') {
      return c.html('<p class="feed-error" role="alert">content must be a string</p>', 400);
    }
    // Pure sanitizing render of untrusted input — identical to live posts.
    return c.html(renderContent(content), 200);
  });

  return route;
}
