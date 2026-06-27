# Stack Decision — Slack that Theo wants

> C0 artifact. Records the technology choices for the project so every later
> chunk shares conventions. This is a decision record, not a tutorial.

## Decision

| Concern            | Choice                                   |
| ------------------ | ---------------------------------------- |
| Language           | TypeScript (strict)                      |
| Runtime            | Node.js 20+                              |
| Package manager    | npm (ships with Node; no extra lockfile) |
| Web framework      | Hono (web-standard, routing, middleware) |
| Server adapter     | `@hono/node-server`                      |
| Dev runner         | `tsx watch`                              |
| Build              | `tsc` → `dist/`                          |
| Test runner        | Vitest (node env)                        |
| Formatter + linter | Biome (single tool, fast, zero config)   |
| Typecheck          | `tsc --noEmit`                           |
| Persistence (C1+)  | SQLite via `better-sqlite3` (local-first) |

## Rationale

- **TypeScript + Node** is the boring, well-understood full-stack choice with
  strong tooling and a large hiring pool; strict mode (`strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) catches the class of
  null/undefined bugs the post/comment tree model is vulnerable to.
- **Hono** is a tiny web-standard framework with first-class middleware and
  routing. It runs on Node today and can target other runtimes later. Its
  in-memory `app.request()` makes HTTP-level tests fast and dependency-free —
  ideal for the C0 smoke test and later C2/C3 API tests.
- **Vitest** is native ESM, TypeScript-aware, and shares configuration with the
  build toolchain. Node environment matches the server runtime.
- **Biome** combines formatting and linting in one fast tool with sensible
  defaults, reducing config surface and CI time versus a Prettier+ESLint pair.
- **SQLite (`better-sqlite3`)** is local-first, serverless, and fast enough for
  development and the MVP. It supports recursive CTEs (needed for unlimited
  nested replies, see C1) and keeps the dev story to one command. It is a C1
  dependency, not installed in C0 — recorded here so C1 does not re-litigate it.

## Non-goals (this decision)

- No ORM mandate; C1 may choose raw SQL + a thin repository layer or a query
  builder. The choice is recorded in C1, not here.
- No frontend framework mandate; C4 will choose a UI approach consistent with
  Hono's server-rendered or hybrid options. C0 ships no UI.
- No containerization or deployment target; local dev only for the MVP.

## Verification mapping (C0)

- `npm install` then `npm test` runs the smoke test on a fresh checkout.
- `npm run dev` starts the server bound to loopback (`127.0.0.1` by default;
  `HOST=0.0.0.0` opts in to all-interface binding); `GET /health` responds with
  `status: "ok"`.
- `npm run build`, `npm run lint`, `npm run typecheck` each exit clean.
- Only `dev`, `build`, `test`, `lint`, and `typecheck` are declared; no other
  scripts are declared until a later chunk verifies them.

## C1 decisions (persistence/domain)

These are recorded here so later chunks do not re-litigate them.

- **Persistence approach:** raw SQL via `better-sqlite3` plus a thin repository
  layer (`src/domain/repositories.ts`). No ORM. Migrations are versioned
  up/down SQL executed by a small runner (`src/db/migrator.ts`) with a
  `schema_migrations` tracking table.
- **Unlimited-depth comment tree storage strategy:** adjacency list
  (`comment_node.parent_id` self-referential FK, nullable for first-level
  comments) plus a recursive CTE for subtree fetch. Chosen over materialized
  path to avoid path-maintenance burden on every insert/move; SQLite supports
  recursive CTEs natively, so arbitrary-depth reads are a single query.
  `root_post_id` is stored on every node for O(1) root lookup and to drive the
  shared bump helper.
- **Actor polymorphism:** a single `actor` table with a `kind` discriminator
  constrained to `'human' | 'agent'`. Posts and comments reference
  `author_actor_id` → `actor.id`, so human and agent rows both satisfy the
  author FK. C7 adds agent credentials/control-plane access on top of this
  type; it does not redefine it.
- **Feed-bump invariant:** a single shared helper
  (`bumpPostLastActivity`) performs the atomic `post.last_activity_at` update
  inside the same transaction as every comment/reply insert. The helper is
  monotonic: out-of-order older comment/reply timestamps do not move the
  feed-ordering field backward. C2 and C3 reuse it and must not invent
  competing bump logic.
- **Workspace boundary:** enforced at the data layer via composite FKs
  (`(workspace_id, author_actor_id)` → `actor(workspace_id, id)`) and a
  consistency trigger that rejects a comment whose workspace differs from its
  root post or whose parent belongs to a different workspace/root post.
- **Soft-delete:** `deleted_at` nullable timestamp on `post` and
  `comment_node`; hard delete is out of MVP scope. A trigger rejects new
  comment/reply inserts into a soft-deleted post or any soft-deleted comment
  ancestor; repository reads return tombstones (redacted author/content,
  preserved identity and tree structure).


## C1a decisions (security baseline)

These are recorded here so later chunks do not re-litigate them.

- **Membership model:** a `workspace_member` table (migration 0002) with one
  row per (workspace_id, actor_id) and a `role` discriminator constrained to
  `'read' | 'write'` (`'write'` implies `'read'`). An actor is a member of
  exactly its own workspace; a composite FK to `actor(workspace_id, id)`
  enforces membership cannot exist in a workspace the actor does not belong
  to. The full membership lifecycle (invites, shares, multi-workspace
  membership, role changes) is deferred to C9; this table is the durable
  backbone C9 extends.
- **Auto-membership:** a trigger seeds a `'write'` `workspace_member` row
  whenever an actor is inserted, so every actor is a member of its own
  workspace with write access by default. C9 replaces this with explicit
  invite/share.
- **Principal resolution (stubbed):** `resolvePrincipal` maps a request to a
  `Principal` (actor + workspace + kind + role) via stubbed `x-actor-id` /
  `x-workspace-id` headers, validated against the membership table. This is
  the ONLY place that knows how to extract an identity from a request in C1a;
  C9 swaps it for real sign-in (session cookies / tokens) while keeping the
  `Principal` shape and the middleware that consume it. The resolver depends
  on a narrow `PrincipalRequest` interface (`header(name)`) so C9 can replace
  extraction without touching the membership-validation core.
- **Authorization middleware:** a single Hono middleware (`authMiddleware`)
  resolves the principal and stores it on the context as `principal`;
  `requireRole('read' | 'write')` adds a route-level role baseline. Every
  later exposed surface (C2/C3/C7/C8) routes through this middleware.
  Per-resource workspace checks use `assertCanRead` / `assertCanWrite` against
  `c.get('principal')`. `AuthorizationError` maps to 401 (missing/unknown
  principal) or 403 (membership/role/workspace mismatch) with a stable
  machine-readable `code`.
- **Scope/filter helpers:** pure functions over a `Principal`
  (`filterByScope`, `readableByScope`, `workspaceScopePredicate`,
  `authorizeWriteBatch`) are the shared contract C2 (feed), C3 (subtree),
  C7 (agent feed polling), and C8 (realtime event fan-out) apply before
  ordering/pagination to exclude cross-workspace records for both human and
  agent principals. C1a exposes the helpers without exposing those surfaces.

## C3a decisions (safe content rendering)

These are recorded here so later chunks do not re-litigate them.

- **Rendering strategy:** a custom Markdown-subset renderer with strict
  allowlisting, implemented in `src/rendering/render.ts`. Chosen over a
  markdown library + DOM-based sanitizer (e.g. markdown-it + DOMPurify/jsdom)
  because the server runtime is Node (no DOM), and a custom allowlisting
  renderer keeps the security surface small, fully auditable, and dependency
  free — consistent with the project's thin-layers / no-unnecessary-deps
  philosophy. The supported grammar is deliberately tiny: paragraphs, ATX
  headings, blockquotes, unordered/ordered lists, fenced and inline code,
  strong/emphasis, links, and hard/soft line breaks. C6 adds syntax
  highlighting and copy affordances on top of this renderer and must not
  bypass it.
- **Sanitization model:** no raw HTML ever passes through. Every user text
  byte is HTML-escaped (`&`, `<`, `>`, `"`, `'`); the only live tags in output
  are the fixed set the renderer emits (`p`, `h1`–`h6`, `blockquote`, `ul`,
  `ol`, `li`, `pre`, `code`, `strong`, `em`, `a`, `br`). Link destinations are
  scheme-allowlisted to `http`, `https`, `mailto`, and relative URLs (`/`,
  `#`, `?`); `javascript:`, `data:`, `vbscript:`, and all other schemes are
  dropped. Control/whitespace characters that can hide a scheme are stripped
  before scheme parsing. Fenced-code language hints are restricted to a safe
  class-name charset.
- **Reusable API:** `renderContent` is the single sanitizing entry point over
  a content string. `renderPostContent(input)` and
  `renderCommentContent(input, surface)` accept renderer-owned narrow inputs:
  `{ content: string }` for live post/comment/reply content or
  `{ isDeleted: true }` for a tombstone/deleted marker. They return a
  `RenderedContent` (`{ surface, html, isTombstone }`). C3a intentionally
  depends only on C0 and does not import C1 domain view types or predicates;
  C4/C5 adapters should map their own post/comment/reply view shapes into this
  narrow input before rendering. Tombstones render a fixed placeholder and never
  reference redacted content. The barrel is `src/rendering/index.ts`.

## C3 decisions (comment/reply API with unlimited nesting)

These are recorded here so later chunks do not re-litigate them.

- **Bump logic reuse:** C3 never reimplements the feed bump. Every comment and
  reply delegates to `DomainRepository.createComment` / `createReply`, which run
  the shared C1 `bumpPostLastActivity` helper inside the same transaction as the
  insert. The endpoint-level bump is therefore the same data-layer guarantee C2
  relies on; C3 only adds the HTTP surface and boundary checks.
- **Reply-target context (`replyToActorId`):** the actor being replied to is the
  parent node's author, derived at read time from the parent's `authorActorId`
  rather than stored on a separate column. This keeps the C1 adjacency-list
  schema the single source of truth for the tree and guarantees the target
  context is always consistent with the live parent. A first-level comment has
  `replyToActorId: null`. When the parent has been soft-deleted, its author is
  redacted by the tombstone contract, so the reply's `replyToActorId` is null —
  the reply itself remains retrievable with its own author/content intact. The
  field is queryable via the subtree and full-thread endpoints so clients can
  show "replying to @X" context without clogging the main post.
- **Deleted-parent behavior:** replies into a soft-deleted subtree are rejected
  at the API layer (`DeletedParentError` → 409 `deleted_parent`) before reaching
  the repository; the C1 data-layer trigger
  `enforce_no_insert_into_deleted_subtree` is the durable backstop. Subtree and
  full-thread reads return soft-deleted nodes as tombstones (redacted
  author/content, preserved id/parent/root and `deletedAt`) with their children
  still retrievable, so the tree structure survives a mid-tree deletion.
- **Stable sibling ordering:** siblings under the same parent are ordered
  `createdAt ASC, id ASC`. This is enforced by the repository's recursive-CTE
  `sort_path` (`created_at || char(31) || id`, joined across levels with
  `char(30)`) and preserved by the service's `assembleTree`, which groups the
  depth-first pre-order row stream under each parent without re-sorting.
- **Subtree vs full thread:** `GET /comments/:id/subtree` returns one subtree
  rooted at any comment (inclusive of the root). `GET /posts/:postId/thread`
  returns every first-level comment under a post, each with its subtree
  assembled. The full-thread endpoint returns C3 tree data only; C2's read-post
  metadata (total/first-level counts) is unchanged and remains the C2 surface.
  A soft-deleted post still returns its preserved comment tree (children
  survive; new replies are blocked by the trigger).
- **Workspace/group boundary:** every C3 endpoint routes through the C1a
  `authMiddleware` + `requireRole`, and the service calls `assertCanRead` /
  `assertCanWrite` against the target's workspace before any read/write. A
  tombstone target redacts `workspaceId`, so the service derives the workspace
  from the root post for the boundary check (never leaking whether a
  cross-workspace node is deleted). `AuthorizationError` is mapped by the
  shared C1a error handler; C3 not-found errors map to 404 and
  deleted-parent to 409.

## C4 decisions (minimal human UI: feed and post creation)

These are recorded here so later chunks do not re-litigate them.

- **UI approach:** server-rendered HTML via Hono `c.html()`. No frontend
  framework is introduced. Chosen over a client SPA because the stack is
  Hono server-side with no DOM dependency, the feed is read-mostly, and a
  server-rendered page keeps the security surface small (content is sanitized
  once on the server via C3a before it ever leaves the process). C5/C6 may add
  progressive enhancement on top of this same route; C8 adds realtime. The feed
  is mounted at `GET /feed` (the JSON discovery root at `/` is preserved so the
  C0 health smoke test stays green).
- **C2 consumption:** the feed view calls the C2 `PostService.listFeed`
  directly in-process (server-side), not via a self-HTTP call. Posts are
  rendered in the exact order the service returns them — the UI never re-sorts
  client-side. The create-post form posts to `POST /feed`, which calls
  `PostService.createPost` and re-renders the feed so the new post appears at
  the top.
- **C3a rendering:** every post body is routed through `renderPostContent`
  before insertion into the HTML. Raw stored content is never emitted. Static
  template text (author id, timestamps, ids) is HTML-escaped via a local
  `escapeText` helper; the C3a-rendered body HTML is inserted as-is because it
  is already the product of the allowlisting renderer.
- **Principal resolution (C1a reuse):** the UI resolves the principal through
  the same C1a `membership.resolveMembership` + `membershipToPrincipal` core as
  the API middleware. Credentials are read from request headers first (API
  clients), then query parameters on GET and form fields on POST (browsers with
  no custom-header support). The pair is always validated against the
  membership table; C9 swaps the extraction, not the validation. The
  create-post form carries the principal credentials as hidden inputs so it is
  self-contained.
- **States:** empty state when the workspace has no posts; error state when
  principal resolution fails (401/403 error document) or the feed read throws
  (500 with error block); a progressive-enhancement loading indicator toggles
  `is-loading` / `aria-busy` on form submit, with a `<noscript>` fallback that
  still submits normally. Server-rendered content is already present, so a
  true loading spinner is only meaningful for the create-post round-trip.

## C5 decisions (conversation UI: comments and nested replies)

These are recorded here so later chunks do not re-litigate them.

- **Route shape:** the post detail conversation UI lives under the existing
  server-rendered human UI mount at `GET /feed/:postId`, with mutation forms at
  `POST /feed/:postId/comments` and
  `POST /feed/:postId/comments/:commentId/replies`. Keeping the detail page
  under `/feed` lets C4 post cards link to "View conversation" without adding a
  second browser UI root; JSON API routes remain the C2/C3 `/posts` and
  `/comments` surfaces.
- **Service consumption:** the detail page calls the C2 `PostService.readPost`
  in-process for the post body and live comment metadata, and calls the C3
  `CommentService.getFullThread` / `createComment` / `createReply` methods for
  the tree and form mutations. It does not self-HTTP-call API routes or
  duplicate feed-bump logic; reply bumps remain the C1/C3 data-layer invariant.
- **Renderer boundary:** post bodies continue through `renderPostContent`; every
  comment and reply node is adapted to `renderCommentContent` with surface
  `comment` or `reply`. Tombstones are adapted to `{ isDeleted: true }`. Raw
  stored post/comment/reply content is never emitted by templates; static ids,
  actors, timestamps, counts, and error text use the shared UI `escapeText`
  helper.
- **Principal resolution:** C5 reuses the C4 shared UI principal path
  (`resolveUiPrincipal` over headers, query params, or hidden form fields, then
  C1a membership validation). C9 can replace credential extraction without
  changing the post detail route or form contracts.
- **Tree presentation:** first-level comments render inline below the post, each
  live comment/reply has its own reply composer, and replies show compact
  "Replying to @actor" context from C3 `replyToActorId`. Nested branches are
  indented with semantic lists, deep branches switch to `<details>`, and a
  maximum render-depth safeguard collapses descendants beyond the configured
  limit so pathological trees cannot explode the server-rendered document.

## C6 decisions (code block / message authoring experience)

These are recorded here so later chunks do not re-litigate them.

- **Highlighting strategy: dependency-free tokenizer.** A custom, single-pass
  tokenizer (`src/rendering/highlight.ts`) recognizes a small, well-known set of
  tokens (comments, strings, numbers, keywords, literals, punctuation) for
  TypeScript/JavaScript and aliases (`ts`/`tsx`/`typescript`/`js`/`jsx`/
  `javascript`/`mjs`/`cjs`). Unrecognized languages fall back to a single
  `plain` token so the code is still rendered verbatim with formatting intact.
  Chosen over a library (highlight.js/Shiki) to keep the security surface small,
  fully auditable, and dependency-free, consistent with the C3a thin-layers
  philosophy. The server runtime is Node, not a browser, so a DOM-based
  highlighter is not an option.
- **Safety model (unchanged from C3a):** the highlighter never introduces live
  HTML on its own. It tokenizes the **raw** code into typed spans; the renderer
  (`renderCodeBlock`) HTML-escapes each token's text and wraps it in
  `<span class="tok-{kind}">…</span>`. The only new live tags C6 adds to the
  renderer's emitted set are `span` (with a class from the fixed `TOKEN_KINDS`
  allowlist), `figure`, and `button` (the copy affordance) — no event handlers,
  no attributes carrying user content, no raw markup ever passes through. The
  language hint is restricted by the existing `safeLanguageHint` to a safe
  class-token charset, so it cannot inject markup into the `class` or
  `data-lang` attributes.
- **Copy affordance: progressive enhancement, no payload attribute.** Each code
  block is wrapped in `<figure class="code-block">` with a `<button
  class="copy-code">Copy</button>`. The copy script reads `code.textContent`
  from the DOM; the browser unescapes HTML entities when reading `textContent`,
  so the clipboard receives the original code bytes without any user content
  being duplicated into an attribute (which would have re-introduced an
  injection surface and broken sanitization assertions). Without JS the code is
  still fully visible and selectable. The script uses `navigator.clipboard`
  with a `document.execCommand('copy')` fallback.
- **Formatting preservation in nested replies:** the C5 path
  (`renderCommentContent` → `renderContent` → `renderBlocks` →
  `renderCodeBlock`) already renders replies through the same renderer as
  posts; C6 only changes what `renderCodeBlock` emits. Indentation and newlines
  are preserved verbatim inside `<pre>`, and highlight spans wrap escaped text
  only, so formatting survives every surface (post, comment, reply, blockquote
  nesting).
- **Optional preview mode:** `POST /feed/preview` renders raw composer text
  through `renderContent` and returns the safe HTML fragment. The composer
  preview toggle (in both the feed create-post form and the post-detail
  comment/reply composers) POSTs the textarea value and inserts the response
  into a preview pane. The preview is always produced by the same sanitizing
  renderer as live content, so it can never introduce unsanitized markup.
  Principal resolution is required to keep the surface consistent with the C1a
  authorization baseline.
- **Shared UI assets:** the code-block CSS, copy script, and preview script
  live in `src/ui/codeBlockUi.ts` as static strings interpolated into the C4
  feed and C5 post-detail documents, avoiding duplication. They contain no user
  content and no template interpolation.


## C7 decisions (agent identity and API control plane)

These are recorded here so later chunks do not re-litigate them.

- **Agent identity reuse:** C7 does NOT redefine the C1 actor schema. Agent
  identity reuses the existing `actor` table with `kind = 'agent'`; there is no
  separate bot-message table. Agent-specific profile/metadata fields
  (description, status, capabilities) live in a new `agent_profile` table
  (migration 0003) keyed 1:1 by `actor_id`, guarded by a trigger that rejects a
  profile row referencing a non-agent actor. This keeps the C1 actor schema the
  single source of truth for actor polymorphism.
- **Credential storage:** agent API tokens are stored HASHED (scrypt + per-
  credential random salt, format `saltHex$hashHex`) in `agent_credential`. The
  plaintext secret is NEVER persisted; it is returned exactly once at issuance
  and rotation and is never retrievable again. Verification scans active
  credentials and compares in constant time (`timingSafeEqual`). A credential
  is workspace-scoped via the actor's workspace (composite FK to
  `actor(workspace_id, id)`), so a credential cannot reference an actor in
  another workspace.
- **Credential lifecycle:** issuance creates a new active credential row and
  returns the one-time secret. Rotation issues a new credential and revokes all
  prior active credentials for the actor (old secret rejected on subsequent
  verify). Revocation flips `status` to 'revoked' (single credential or all
  active credentials for an actor). Only hashed material is retained.
- **Principal resolution (agent):** `resolveAgentPrincipal` maps an
  `Authorization: Bearer <secret>` header to a `Principal` by verifying the
  secret against the hashed credential table and resolving the actor's
  membership. This produces the same C1a `Principal` shape as the stubbed
  header resolver, so the shared C1a authorization middleware and per-resource
  `assertCanRead`/`assertCanWrite` checks apply unchanged to agent callers. C9
  replaces credential verification with real sign-in-backed tokens while
  keeping the Principal shape.
- **Audit logging:** every agent create-post/comment/reply action appends a
  row to `agent_audit_log` (actor, workspace, action, target id, root post id,
  idempotency key, timestamp). The log is append-only and read by the agent's
  own audit endpoint and later admin tooling (C9+).
- **Rate limit / quota:** a per-(actor, bucket) counter in `agent_quota_state`
  enforces a rolling-window write quota. The bucket key encodes the window
  (default per-minute). `checkAndConsume` atomically increments only when under
  the limit; excess writes throw `QuotaExceededError` (mapped to 429) BEFORE the
  write occurs, so no duplicate write and no extra feed bump is created when the
  limit is exceeded.
- **Idempotency:** agent writes accept an `x-idempotency-key` header. The key
  is scoped per (actor, action) and stored in `agent_idempotency_key` with the
  resulting target id and a SHA-256 request digest. A replayed write with the
  same key returns the original target (re-read via the C2/C3 read path)
  without re-performing the write — so no duplicate row and no second feed
  bump. This is the durable backstop for retry/replay safety on agent create
  calls.
- **Write-safety contract:** `AgentService.writeWithIdempotency` layers
  idempotency + quota + audit on top of the existing C2 `PostService` and C3
  `CommentService`. The shared C1 bump helper is reused unchanged (agent
  replies bump posts exactly as human replies do); C7 never reimplements bump
  logic.
- **Machine-readable status metadata:** `GET /agents/status` and
  `GET /agents/status/:postId` expose a priority/status metadata contract:
  per-post `lastActivityAt`, `replyCount`, `firstLevelCount`, `status`, and
  `authorKind` (human | agent), ordered by activity (`lastActivityAt DESC,
  postId DESC` — the same order as the human feed). Agents infer priorities
  from activity + counts + actor type without scraping UI text.
- **Least-privilege / redaction:** all agent read endpoints delegate to the C2
  `PostService.listFeed` / `readPost` and C3 `CommentService` methods, which
  scope by the principal's workspace before ordering/pagination. Cross-
  workspace posts/comments are excluded; tombstones are redacted. No cross-
  workspace leakage is possible through the agent surface.
- **HTTP surface:** agent endpoints are mounted under `/agents` and use the
  agent Bearer-token middleware (not the C1a header middleware). C2/C3 human
  endpoints remain unchanged under `/posts` and `/comments`.
