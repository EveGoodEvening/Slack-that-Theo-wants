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
  a content string. `renderPostContent(post: PostView)` and
  `renderCommentContent(node: CommentView, surface)` accept the C1 domain
  view types (live or tombstone) and return a `RenderedContent` (`{ surface,
  html, isTombstone }`). C4 and C5 must route every post/comment/reply body
  through these and must never interpolate raw stored content. Tombstones
  render a fixed placeholder and never reference the redacted content. The
  barrel is `src/rendering/index.ts`.
