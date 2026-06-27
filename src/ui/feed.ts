import { Hono } from 'hono';
import type { MembershipRepository } from '../security/membership.js';
import { AuthorizationError, type Principal } from '../security/types.js';
import {
  renderPostContent,
  type RenderableContent,
} from '../rendering/index.js';
import type { PostService, PostDTO } from '../api/postService.js';
import {
  ACTOR_FIELD,
  ACTOR_HEADER_FIELD,
  escapeText,
  resolveUiPrincipal,
  WORKSPACE_FIELD,
  WORKSPACE_HEADER_FIELD,
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
 * Principal resolution reuses the C1a membership-validation core via the shared
 * `resolveUiPrincipal` helper (see `./shared.ts`). The UI reads the stubbed
 * `x-actor-id` / `x-workspace-id` credentials from request headers first (so
 * API-style clients work), then browser `actorId` / `workspaceId` query
 * parameters on GET and form fields on POST. The pair is always validated
 * against the membership table via `membership.resolveMembership`; C9 swaps the
 * extraction, not the validation.
 *
 * States:
 * - empty: the feed has no posts for the principal's workspace.
 * - error: principal resolution failed (401/403) or the feed read threw.
 * - loading: a progressive-enhancement indicator shown while the create-post
 *   form is submitting (noscript fallback submits normally).
 */

export interface FeedRouteDeps {
  membership: MembershipRepository;
  /** Optional service override; defaults to the C2 PostServiceImpl. */
  service: PostService;
}

/** Render a single post card. Body content goes through C3a renderPostContent. */
function renderPostCard(post: PostDTO, principal: Principal): string {
  // The feed endpoint only returns live posts (tombstones are excluded by the
  // C2 service), so we always have content here. We still route through
  // renderPostContent so a tombstone input would render safely if the contract
  // ever changes.
  const renderable: RenderableContent = { content: post.content };
  const rendered = renderPostContent(renderable);
  const conversationHref = `/feed/${encodeURIComponent(post.id)}?${ACTOR_FIELD}=${encodeURIComponent(
    principal.actorId,
  )}&${WORKSPACE_FIELD}=${encodeURIComponent(principal.workspaceId)}`;
  return `    <article class="post-card" data-post-id="${escapeText(post.id)}">
      <header class="post-meta">
        <span class="post-author">${escapeText(post.authorActorId)}</span>
        <time class="post-activity" datetime="${escapeText(post.lastActivityAt)}">${escapeText(post.lastActivityAt)}</time>
      </header>
      <div class="post-body">${rendered.html}</div>
      <p class="post-link"><a href="${escapeText(conversationHref)}">View conversation</a></p>
    </article>`;
}

/** Render the full feed HTML document. */
function renderFeedDocument(
  posts: PostDTO[],
  principal: Principal,
  opts: { error?: string | undefined; notice?: string | undefined } = {},
): string {
  const cards = posts.map((post) => renderPostCard(post, principal)).join('\n');
  const body =
    posts.length === 0
      ? '    <p class="feed-empty">No posts yet. Create the first one above.</p>'
      : cards;

  const errorBlock = opts.error
    ? `    <p class="feed-error" role="alert">${escapeText(opts.error)}</p>`
    : '';
  const noticeBlock = opts.notice
    ? `    <p class="feed-notice" role="status">${escapeText(opts.notice)}</p>`
    : '';

  // The create-post form posts the content + browser principal fields as hidden
  // inputs so a browser without custom-header support still resolves the same
  // C1a principal. The form is the C2 create endpoint surface.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Feed — Slack that Theo wants</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    header.page-header { border-bottom: 1px solid #ddd; padding-bottom: 1rem; margin-bottom: 1rem; }
    form.create-post { margin-bottom: 2rem; }
    form.create-post textarea { width: 100%; min-height: 80px; box-sizing: border-box; padding: 0.5rem; font: inherit; }
    form.create-post button { margin-top: 0.5rem; }
    .post-card { border: 1px solid #e1e1e1; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
    .post-meta { display: flex; justify-content: space-between; color: #555; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .post-body p:first-child { margin-top: 0; }
    .post-body p:last-child { margin-bottom: 0; }
    .post-link { margin: 0.5rem 0 0; font-size: 0.85rem; }
    .feed-empty { color: #666; font-style: italic; }
    .feed-error { color: #b00; }
    .feed-notice { color: #060; }
    .is-loading { opacity: 0.6; }
  </style>
</head>
<body>
  <header class="page-header">
    <h1>Feed</h1>
    <p class="principal">Signed in as <strong>${escapeText(principal.actorId)}</strong> in workspace <strong>${escapeText(principal.workspaceId)}</strong>.</p>
  </header>
${errorBlock}
${noticeBlock}
  <form class="create-post" method="post" action="/feed" id="create-post-form">
    <label for="content">Create a post</label>
    <textarea id="content" name="content" required maxlength="4000" placeholder="Write something…"></textarea>
    <input type="hidden" name="${ACTOR_FIELD}" value="${escapeText(principal.actorId)}" />
    <input type="hidden" name="${WORKSPACE_FIELD}" value="${escapeText(principal.workspaceId)}" />
    <button type="submit">Post</button>
    <noscript><p class="feed-loading">Submitting…</p></noscript>
  </form>
  <section class="feed" id="feed" aria-live="polite">
${body}
  </section>
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
      });
    })();
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
    .feed-error { color: #b00; }
  </style>
</head>
<body>
  <header class="page-header"><h1>Feed</h1></header>
  <p class="feed-error" role="alert">${escapeText(message)} (code: ${escapeText(code)})</p>
  <p>Provide <code>${ACTOR_HEADER_FIELD}</code> / <code>${WORKSPACE_HEADER_FIELD}</code> headers or <code>${ACTOR_FIELD}</code> / <code>${WORKSPACE_FIELD}</code> browser fields.</p>
</body>
</html>`;
}

export function feedRoutes(deps: FeedRouteDeps): Hono {
  const route = new Hono();
  const { membership, service } = deps;

  // GET /feed — landing/feed view consuming the C2 list-feed service.
  route.get('/', (c) => {
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

  // POST /feed — create-post form calling the C2 create endpoint service.
  route.post('/', async (c) => {
    // Read form fields first. The principal credentials arrive as browser hidden
    // inputs so a browser without custom-header support still resolves the same
    // C1a principal; header-based clients are also honored.
    const form = await c.req.formData().catch(() => null);
    const content = form?.get('content');
    const actorField = form?.get(ACTOR_FIELD);
    const workspaceField = form?.get(WORKSPACE_FIELD);
    const actorHeaderField = form?.get(ACTOR_HEADER_FIELD);
    const workspaceHeaderField = form?.get(WORKSPACE_HEADER_FIELD);

    const bodyParams: Record<string, string | undefined> = {
      [ACTOR_FIELD]: typeof actorField === 'string' ? actorField : undefined,
      [WORKSPACE_FIELD]:
        typeof workspaceField === 'string' ? workspaceField : undefined,
      [ACTOR_HEADER_FIELD]:
        typeof actorHeaderField === 'string' ? actorHeaderField : undefined,
      [WORKSPACE_HEADER_FIELD]:
        typeof workspaceHeaderField === 'string'
          ? workspaceHeaderField
          : undefined,
    };

    let principal: Principal;
    try {
      principal = resolveUiPrincipal(c.req, bodyParams, membership);
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

  return route;
}
