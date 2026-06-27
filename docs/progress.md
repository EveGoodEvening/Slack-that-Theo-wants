# Progress Tracker — Slack that Theo wants

> Durable progress artifact. This file tracks the status of chunks defined in
> `docs/implementation-plan.md`. Update **this** file, not the plan, as work
> proceeds. The plan is the stable spec; this is the live tracker.

## Tracker convention

| Marker       | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `[ ]`        | Not started                                                    |
| `[~]`        | In progress (add `— <note>` with worktree/owner if useful)     |
| `[x]`        | Done and verified per the chunk's "Required verification"      |
| `[!]`        | Blocked (add `— <note>` describing the blocker and owner)      |

Rules (mirrored from `docs/implementation-plan.md`):

- An item is `[x]` **only** after its chunk's required verification has passed.
  Implementation alone is not sufficient.
- Chunk status is the aggregate of its checklist items:
  - `not started` — all `[ ]`
  - `in progress` — any `[~]` or mixed
  - `blocked` — any `[!]` blocking further progress
  - `done` — all `[x]`
- When marking blocked, record the blocker and which chunk/owner must resolve
  it.
- Add a dated note under "Progress log" whenever a chunk transitions status.

## Chunk status summary

| Chunk | Status       | Notes |
| ----- | ------------ | ----- |
| C0    | done         | Verified: npm install, test, dev health route, build, lint, typecheck |
| C1    | done         | Verified: npm test (30 tests), build, lint, typecheck after review fixes |
| C1a   | done         | Verified: npm install, test (65 tests), build, lint, typecheck |
| C2    | done         | Verified: npm install, test (132 tests), build, lint, typecheck |
| C3    | done         | Verified: npm install, test (151 tests), build, lint, typecheck |
| C3a   | done         | Verified: npm install, test (109 tests), build, lint, typecheck |
| C4    | done         | Verified: npm install, test (163 tests), build, lint, typecheck |
| C5    | done         | Verified: npm install, test (171 tests), build, lint, typecheck |
| C6    | done         | Verified: npm install, test (192 tests), build, lint, typecheck |
| C7    | done         | Verified: npm install, test (240 tests), build, lint, typecheck |
| C8    | not started  | Depends on C1a, C2, C3, C4, C5 (optionally C7) |
| C9    | not started  | Depends on C1a, C2, C3, C4, C7 |
| C10   | not started  | Depends on all core flows |

## C0 — Product/architecture baseline and scaffold

- [x] Decide and record the stack (language, framework, persistence, test runner, formatter/linter) in `README.md` or a new `docs/stack-decision.md`
- [x] Create package/app manifest with dev/build/test/lint/typecheck scripts
- [x] Create source tree skeleton with a minimal health page or API route
- [x] Add formatter and linter configuration
- [x] Add test runner configuration and a single placeholder-free smoke test that runs
- [x] Add `.gitignore` appropriate to the stack
- [x] Document the one-command dev and one-command test invocations

## C1 — Domain model and persistence migrations

- [x] Define entities: workspace/group, actor (human or agent), post, comment/reply tree node. C1 owns the actor schema including the human/agent discriminator and actor-polymorphism constraints; C7 only adds agent credentials/control-plane access on top
- [x] Model comment/reply as a tree node with `parentId`, `rootPostId`, `authorActorId`, content, timestamps
- [x] Add `lastActivityAt` on post; define it as the feed-ordering field
- [x] Define and implement the shared post-activity bump helper (atomic, monotonic `post.lastActivityAt` update on any new comment/reply) so C2 and C3 reuse one implementation and never invent competing logic
- [x] Implement atomic update of `post.lastActivityAt` on any new comment/reply insertion via the shared bump helper
- [x] Add `deletedAt` nullable timestamp (soft-delete) on post and comment/reply tree nodes; hard delete is out of MVP scope
- [x] Add migration(s) creating all tables with constraints (FK parent/child, actor polymorphism, workspace boundary, soft-delete column)
- [x] Choose and implement unlimited-depth storage strategy (adjacency list + recursive query, or materialized path) — record the choice
- [x] Add repository/schema tests: arbitrary-depth insertion, parent/child constraints, invalid parent rejection, `lastActivityAt` updates on every nested reply, soft-delete tombstone behavior, actor polymorphism (human and agent rows satisfy the actor reference)

## C1a — Security baseline: principal, membership, authorization middleware

- [x] Implement actor principal resolution from requests (stubbed auth mapping a request to an actor + workspace/group; real sign-in deferred to C9) — implemented in src/security/principal.ts; stubbed x-actor-id/x-workspace-id headers validated against membership table; C9 replaces
- [x] Implement baseline workspace/group membership model (enough to scope reads/writes; full membership lifecycle and invite/share deferred to C9) — migration 0002 workspace_member + auto-membership trigger; src/security/membership.ts
- [x] Implement shared authorization middleware with per-endpoint read/write scope checks for workspace/group, reused by all C2/C3/C7/C8 surfaces — src/security/middleware.ts (authMiddleware/requireRole) + authorization.ts (assertCanRead/assertCanWrite)
- [x] Provide reusable workspace/group scope and filtering helpers for later feed, event, agent, and status surfaces without exposing those surfaces in C1a — filterByScope/readableByScope/workspaceScopePredicate/authorizeWriteBatch in src/security/authorization.ts
- [x] Add direct middleware/helper tests proving cross-workspace/group reads and writes are rejected and scoped collection filters exclude unauthorized human and stubbed-agent principals — src/security/security.test.ts verified by orchestrator

## C2 — Post feed API

- [x] Define service interface for post creation and feed listing — src/api/postService.ts
- [x] Implement create-post endpoint (author, workspace/group, content, initial `lastActivityAt`) — POST /posts in src/api/postRoutes.ts
- [x] Implement list-feed endpoint ordered by `lastActivityAt` descending — GET /posts uses `lastActivityAt DESC, postId DESC`
- [x] Implement read-post endpoint returning post + comment-tree metadata — GET /posts/:id returns post plus live total/first-level counts only
- [x] Enforce workspace/group boundary on every endpoint via the C1a authorization middleware (even before real sign-in) — shared auth middleware + per-resource service checks
- [x] Enforce feed listing scope by applying the C1a workspace/group filter helper before ordering/pagination — workspace predicate is resolved before repository query; SQL scopes by workspace before cursor/order/limit
- [x] Add cursor-based pagination for the feed with a deterministic order: `lastActivityAt DESC, postId DESC` (or the stack's stable unique-key equivalent); the cursor encodes this composite order so equal timestamps never produce duplicate or skipped posts
- [x] Add API tests: newest post ordering, old post bumps after C1-seeded comment activity (data-layer bump via the shared C1 bump helper), empty state, pagination cursor behavior including multiple posts sharing the same `lastActivityAt`, cross-workspace rejection, feed listings exclude posts outside the principal's workspace/group — src/api/postRoutes.test.ts verified by orchestrator

## C3 — Comment/reply API with unlimited nesting

- [x] Define service interface for comment/reply creation and subtree fetch — src/api/commentService.ts (CommentService)
- [x] Implement create first-level comment on a post — CommentServiceImpl.createComment → POST /posts/:postId/comments
- [x] Implement create reply to any comment (arbitrary depth) — CommentServiceImpl.createReply → POST /comments/:parentId/replies
- [x] Preserve `replyToActorId` / target context so users can reply to different people without clogging the main post — derived from the parent node's authorActorId at read time; null for first-level comments and redacted (null) when the parent is a tombstone; queryable via subtree/thread fetch
- [x] Implement fetch-subtree and fetch-full-thread endpoints — GET /comments/:id/subtree, GET /posts/:postId/thread
- [x] Ensure every reply triggers the shared C1 atomic `lastActivityAt` bump helper on the root post (no duplicate implementation) — delegates to DomainRepository.createComment/createReply which run bumpPostLastActivity in-transaction
- [x] Define deleted-parent behavior: reject replies to a soft-deleted parent (cannot reply into a deleted subtree); fetching a subtree containing a deleted node returns a tombstone placeholder (redacted author/content) while preserving retrievable children — DeletedParentError → 409 at the API layer; data-layer trigger is the backstop; tombstones preserve children
- [x] Define stable sibling ordering for replies under the same parent (e.g., `createdAt ASC, nodeId ASC`) — repository recursive-CTE sort_path encodes createdAt ASC, id ASC; assembleTree preserves it
- [x] Enforce workspace/group boundary on every endpoint via the C1a authorization middleware — authMiddleware + requireRole on every route; assertCanRead/assertCanWrite in the service before any read/write
- [x] Add API tests: arbitrary-depth insertion, invalid/missing parent rejection, deleted-parent behavior (reply rejected + tombstone with children preserved), sibling ordering, feed bump side effect on every nested reply — src/api/commentRoutes.test.ts verified by orchestrator

## C3a — Safe content rendering baseline

- [x] Choose and record rendering strategy (markdown library, rich-text, or custom) — custom Markdown-subset allowlisting renderer; recorded in docs/stack-decision.md (C3a decisions); src/rendering/render.ts
- [x] Implement safe HTML sanitization/escaping (no script execution) for post/comment/reply content — escape all user text; scheme-allowlist links; drop unsafe schemes; restrict code-block lang hints; src/rendering/render.ts
- [x] Provide a reusable render function/component consumed by C4 and C5 — renderContent + renderer-owned narrow surface helpers renderPostContent/renderCommentContent accepting `{ content }` or `{ isDeleted: true }`; barrel src/rendering/index.ts; no C1 domain imports
- [x] Add tests: injected `<script>`/unsafe HTML does not execute through the renderer; content is escaped/sanitized on every render path; blockquote depth is capped safely; backslash hard breaks render as `<br>` — src/rendering/render.test.ts

## C4 — Minimal human UI: feed and post creation

- [x] Implement feed/landing view consuming the C2 list-feed endpoint — src/ui/feed.ts GET /feed over PostService.listFeed; mounted in src/index.ts
- [x] Render post cards ordered by API response order (do not re-sort client-side) — posts rendered in service.listFeed order; verified by feed.test.ts ordering tests
- [x] Render all post content through the C3a safe renderer/sanitizer (never render raw stored content) — renderPostContent on every post body in src/ui/feed.ts
- [x] Implement create-post form calling the C2 create endpoint — POST /feed form calls PostService.createPost then re-renders
- [x] Add loading, error, and empty states — empty/error/notice blocks + progressive-enhancement loading indicator in src/ui/feed.ts
- [x] Add component or E2E test proving creating a post appears in the feed — src/ui/feed.test.ts "creates a post via the form and it appears at the top of the feed"
- [x] Add test proving feed ordering follows the API order — src/ui/feed.test.ts "renders posts in API response order" + "does not re-sort"
- [x] Add test proving unsafe HTML/script in post content is escaped/sanitized on the feed and post-creation surfaces (via the C3a renderer) — src/ui/feed.test.ts "C4 unsafe HTML/script is escaped/sanitized" suite

## C5 — Conversation UI: first-level comments and nested replies

- [x] Implement post detail view consuming C2 read-post and C3 subtree endpoints — implemented as server-rendered `/feed/:postId` over C2 read-post + C3 full-thread service; verified by orchestrator
- [x] Render first-level comments inline under the post — implemented in `src/ui/postDetail.ts`; verified by orchestrator
- [x] Implement nested reply composer on each comment/reply — implemented for live nodes; tombstones render without a composer; verified by orchestrator
- [x] Implement indentation and collapse strategy for deep trees (with rendering safeguard for very deep nesting) — semantic nested lists, `<details>` collapse, and max-depth safeguard implemented; verified by orchestrator
- [x] Show reply-target context (who is being replied to) without clogging the main post — displays compact `Replying to @actor` context from C3 `replyToActorId`; verified by orchestrator
- [x] Render all comment/reply content through the C3a safe renderer/sanitizer (never render raw stored content) — `renderCommentContent` used for every comment/reply/tombstone surface; verified by orchestrator
- [x] Add E2E test proving replying to different comments renders in the correct location — added in `src/ui/postDetail.test.ts`; verified by orchestrator
- [x] Add E2E test proving a reply on an old post bumps it to the top of the feed — added in `src/ui/postDetail.test.ts`; verified by orchestrator
- [x] Add test proving unsafe HTML/script in comment/reply content is escaped/sanitized on every nested reply surface (via the C3a renderer) — added in `src/ui/postDetail.test.ts`; verified by orchestrator

## C6 — Code block / message authoring experience

- [x] Implement fenced code block rendering with syntax highlighting and copy affordance (on top of the C3a renderer) — `renderCodeBlock` now wraps fenced code in `<figure class="code-block">` with a `<pre><code>` body, dependency-free token highlighting (`src/rendering/highlight.ts`), and a copy `<button>`; verified by orchestrator
- [x] Ensure code formatting is preserved inside nested replies — the C5 `renderCommentContent` → `renderContent` → `renderBlocks` → `renderCodeBlock` path preserves indentation/newlines verbatim; highlighted spans wrap escaped text only; verified by orchestrator
- [x] Add optional preview mode — `POST /feed/preview` renders raw composer text through `renderContent`; composer preview toggle in feed + post detail; verified by orchestrator
- [x] Add tests: code fences render as code, code formatting preserved in nested replies, code-block content is still sanitized (defense-in-depth via C3a) — added in `src/rendering/render.test.ts` and `src/ui/postDetail.test.ts`; verified by orchestrator

## C7 — Agent identity and API control plane

- [x] Use the existing C1 human/agent actor type for agent identity (no separate bot-message table); add only agent-specific profile/metadata fields. The actor schema itself is owned by C1 and must not be re-defined here — agent identity reuses C1 actor kind='agent'; agent-specific profile/metadata in src/security/agentProfile.ts (agent_profile table, migration 0003); actor schema untouched
- [x] Implement scoped API tokens or service credentials for agents, stored hashed (never plaintext), with one-time secret display at issuance — src/security/credentials.ts (scrypt+salt hash, one-time plaintext return at issuance/rotation, never persisted)
- [x] Implement credential rotation and revocation — AgentCredentialRepository.rotate/revoke/revokeAllForActor
- [x] Add audit logging for agent write actions (create post/comment/reply) — src/security/audit.ts + AgentService writes audit record per create-post/comment/reply
- [x] Add rate limits/quotas for agent API calls — src/security/rateLimit.ts (per-actor rolling-window counter, QuotaExceededError → 429)
- [x] Require idempotency keys for agent create-post/comment/reply calls to prevent duplicate replies and extra bumps on retry/replay — x-idempotency-key is required on HTTP create endpoints; src/security/idempotency.ts + AgentService.writeWithIdempotency return original results on replay with no duplicate/bump
- [x] Expose endpoints for agents to create posts/comments/replies using the same C2/C3 services, routed through the C1a authorization middleware — src/api/agentRoutes.ts mounted at /agents; reuses PostService/CommentService; agent Bearer-token principal resolution via resolveAgentPrincipal
- [x] Expose machine-readable feed polling or event subscription endpoint with least-privilege/redaction for agent callers — GET /agents/feed delegates to C2 PostService.listFeed (workspace-scoped)
- [x] Define and expose a machine-readable priority/status metadata contract (per-post `lastActivityAt`, reply count, active/unresolved status, actor type) ordered by activity, so agents can infer priorities without scraping UI text — GET /agents/status + GET /agents/status/:postId (AgentService.listStatus/readStatus, PostStatusEntry)
- [x] Redact/least-privilege scope feed, event, and status metadata APIs for agent callers (no cross-workspace leakage) — all agent reads delegate to C2/C3 services which enforce workspace scope; cross-workspace posts excluded
- [x] Add API tests proving an agent can join a post/comment tree and its replies bump posts identically to human replies; credential lifecycle (hashed storage, one-time issuance, rotation, revocation); audit logging for create post/comment/reply; rate-limit/quota enforcement; idempotency (no duplicate reply/bump on replay); metadata redaction; related migration apply/rollback for any C7 persistent security structures — src/api/agentRoutes.test.ts verified by orchestrator

## C8 — Realtime / activity updates

- [ ] Choose and record transport (websocket, SSE, or polling)
- [ ] Emit actor-agnostic events from the shared post/comment/reply services on post creation, comment/reply creation, and agent replies (so C7 agent endpoints dispatch through the same event path; C7 remains optional)
- [ ] Define a versioned event contract: versioned event names/payloads, producer and consumer dispatch responsibilities (feed vs post-detail handlers), authorization/filtering rules per workspace/group, unknown-event behavior, and compatibility/rollback expectations
- [ ] Filter realtime events by workspace/group membership via the C1a authorization middleware (no cross-workspace leakage)
- [ ] Implement live feed reordering so bumped posts move to the top without refresh
- [ ] Implement live post-detail update for new comments/replies
- [ ] Add integration/E2E tests proving a background comment on an old post moves it to the top without manual refresh; each emitted event type reaches the intended feed and post-detail handlers; events do not leak across workspace/group boundaries

## C9 — Auth, workspace boundaries, collaboration base

- [ ] Implement real sign-in, replacing the C1a stubbed principal resolution with authenticated principals
- [ ] Extend the C1a baseline membership model with the full membership lifecycle and invite/share model
- [ ] Implement channel/group-level feed boundaries
- [ ] Implement invite/share model
- [ ] Replace the C1a stubbed auth in the shared authorization middleware with sign-in-backed principals; retain per-endpoint read/write scope checks across all C2/C3 endpoints
- [ ] Ensure agent credentials inherit correct workspace/group scope
- [ ] Add migrations/constraints/backfills for auth, membership, invite/share, and agent-credential-scoping tables; preserve earlier workspace/group/post/comment data
- [ ] Verify migrations apply on a fresh database, migrate from the pre-C9 state, and roll back cleanly; seed any default membership required to keep existing data accessible
- [ ] Add tests proving users cannot read/write outside their workspace/group
- [ ] Add tests proving agent credentials inherit correct scope
- [ ] Add tests proving C9 migrations apply cleanly, migrate from pre-C9 state without data loss, and roll back cleanly; seeded/default membership preserves access to pre-C9 data

## C10 — Hardening and review pass

- [ ] Accessibility pass on feed and post-detail views
- [ ] Error-state completeness (network failures, permission denied, not found)
- [ ] Database indexes for feed query and comment-tree query
- [ ] Performance check/benchmark for deep nesting and feed pagination
- [ ] Local-dev documentation (install, run, test)
- [ ] API usage documentation for human and agent consumers
- [ ] Targeted tests for deep-nesting rendering and feed pagination performance

## Known blockers / deferred items

- **C0 stack decision:** Resolved — see `docs/stack-decision.md`. C0 is done;
  downstream chunks may proceed per their dependency ordering.
- **Slack cross-company federation:** Strategically important
  (`README.md:7`) but unspecified. Deferred to post-MVP roadmap.
- **Notifications, search, moderation (including hard delete):** Unspecified in
  `README.md`; deferred. MVP uses soft-delete only.
- **Full agent protocol/identity/security boundary:** Minimally specified; C7
  covers the minimum (credentials, control plane, write-safety), fuller protocol
  deferred.
- **Theo endorsement:** None (`README.md:3`); naming/marketing must not imply
  endorsement. Not a code blocker.

## Progress log

<!-- Append a dated line whenever a chunk transitions status.
     Format: YYYY-MM-DD — Chunk X: <old> -> <new> — <note> -->

- 2026-06-27 — Plan and tracker created. All chunks `not started`. First
  normal C0 task: stack decision.
- 2026-06-27 — Plan review fixes applied. Added C1a (security baseline) and
  C3a (safe content rendering) chunks; clarified C1 actor-schema ownership,
  C2 bump verification, C3 deleted-parent behavior, C7 agent credential
  lifecycle/metadata, C8 event contract, C9 migration/rollback accounting,
  C0 stack status and script verification. All chunks remain `not started`.
- 2026-06-27 — Remaining plan-review corrections applied. C1a verification is
  now independent of C2 feed APIs and C8 event streams; C7 verification now
  covers rotation, audit logging, rate-limit/quota enforcement, and related
  migration apply/rollback if persistent security structures are introduced.
  All chunks remain `not started`.
- 2026-06-27 — Chunk C0: not started -> done — Verified `npm install`,
  `npm test`, `npm run build`, `npm run lint`, `npm run typecheck`, and
  `npm run dev` with `GET /health` returning `{ "status": "ok" }`.
- 2026-06-27 — Chunk C0: review fixes applied. Removed unverified manifest
  scripts (`start`, `test:watch`, `format`, `check`); dev server now binds to
  loopback (`127.0.0.1`) by default with `HOST=0.0.0.0` opt-in and logs the
  actual bound host; cleared the stale C0 stack-decision blocker (resolved via
  `docs/stack-decision.md`). C0 remains `done`.
- 2026-06-27 — Chunk C1: not started -> in progress — Implementation complete
  in worktree `chunk/C1`. Added `better-sqlite3` dep; domain schema migration
  (workspace/actor/post/comment_node) with FK parent/child, actor-polymorphism
  discriminator, workspace-boundary composite FKs + consistency trigger,
  soft-delete columns, and a no-reply-into-deleted-subtree trigger. Storage
  strategy: adjacency list + recursive CTE (recorded in stack-decision.md).
  Shared `bumpPostLastActivity` helper; repository layer with transactional
  comment/reply create that bumps root post atomically. 21 repository/schema
  tests pass (arbitrary depth, parent/child constraints, invalid-parent
  rejection, nested-reply bump, soft-delete tombstone + children preserved,
  actor polymorphism). `npm run lint`, `npm run typecheck`, `npm test` all
  clean. Pending orchestrator verification before marking `[x]`.
- 2026-06-27 — Chunk C1: in progress -> done — Orchestrator verified
  `npm install`, `npm test` (24 tests), `npm run build`, `npm run lint`, and
  `npm run typecheck` in worktree `chunk/C1`.
- 2026-06-27 — Chunk C1: review fixes applied without running commands per
  instruction. Added C1-only fixes for deleted-subtree insert rejection,
  post/comment tombstones, monotonic activity bumps, self-parent rejection, and
  depth-first subtree preorder; verification recorded in the following entry.
- 2026-06-27 — Chunk C1: review fixes verified — Orchestrator verified
  `npm test` (30 tests), `npm run build`, `npm run lint`, and
  `npm run typecheck` after tombstone-read fix; C1 remains `done`.
- 2026-06-27 — Chunk C1a: not started -> in progress — Implementation
  complete in worktree `chunk/C1a`. Added migration 0002 (`workspace_member`
  table + auto-membership trigger) in src/db/migrations/0002-membership.ts;
  security module under src/security/ (types, membership repository, stubbed
  principal resolver, authorization helpers, Hono middleware, barrel index).
  Reusable scope/filter helpers (filterByScope, readableByScope,
  workspaceScopePredicate, authorizeWriteBatch, assertCanRead/assertCanWrite)
  for C2/C3/C7/C8 surfaces. Direct tests in src/security/security.test.ts
  cover cross-workspace read/write rejection through the middleware and
  scoped filter include/exclude for human and stubbed-agent principals, plus
  role enforcement and migration 0002 apply/rollback. Updated C1 test
  migration assertions for the new migration. Initial gate run found Hono
  middleware/type-only import issues; fixes are verified in the following entry.
- 2026-06-27 — Chunk C1a: in progress -> done — Orchestrator verified
  `npm install`, `npm test` (65 tests), `npm run build`, `npm run lint`, and
  `npm run typecheck` after gate and review fixes; C1a remains `done`.
- 2026-06-27 — Chunk C3a: not started -> in progress — Implementation
  complete in worktree `chunk/C3a`. Rendering strategy: custom Markdown-subset
  allowlisting renderer (no DOM dependency, fully auditable), recorded in
  docs/stack-decision.md. Added src/rendering/render.ts (renderContent core
  sanitizer + renderPostContent/renderCommentContent surface helpers over
  renderer-owned `{ content }` / `{ isDeleted: true }` inputs, with tombstone
  placeholders) and barrel src/rendering/index.ts; src/rendering has no C1
  domain imports. Tests in src/rendering/render.test.ts cover script / iframe /
  img-onerror / svg payloads, javascript:/data:/vbscript: link rejection,
  control-char scheme hiding, attribute quote-breakout, code-block lang-hint
  injection, post/comment/reply surfaces, tombstones, capped blockquote nesting,
  backslash hard breaks, and a cross-surface invariant that no render path emits
  unescaped stored content.
  Review fixes applied for blockquote depth, backslash hard breaks, and C1-domain decoupling; orchestrator verified `npm install`, `npm test` (109 tests), `npm run build`, `npm run lint`, and `npm run typecheck`. C3a is `done`.
- 2026-06-27 — Chunk C2: not started -> done — Implemented create/list/read
  post API with C1a authorization and composite feed cursor; orchestrator
  verified `npm install`, `npm test` (132 tests), `npm run build`,
  `npm run lint`, and `npm run typecheck` after gate fixes. C2 is `done`.
- 2026-06-27 — Chunk C2: review fixes verified — Deferred local database
  bootstrap to the direct dev-server path, switched default DB to ignored
  `app.sqlite`, removed generated `app.db*` artifacts, and reverified
  `npm test` (132 tests), `npm run build`, `npm run lint`, and
  `npm run typecheck`. C2 remains `done`.
- 2026-06-27 — Chunk C3: not started -> done — Implemented comment/reply
  API with arbitrary-depth replies, subtree/thread fetch, C1 bump-helper reuse,
  deleted-parent behavior, stable sibling ordering, and C1a authorization;
  orchestrator verified `npm install`, `npm test` (151 tests),
  `npm run build`, `npm run lint`, and `npm run typecheck` after type and
  review fixes. C3 is `done`.
- 2026-06-27 — Chunk C4: not started -> done — Implementation
  complete in worktree `chunk/C4`. Added server-rendered feed UI in
  `src/ui/feed.ts` (GET /feed consumes C2 PostService.listFeed in API order;
  every post body routed through C3a renderPostContent; POST /feed create-post
  form calls PostService.createPost then re-renders; empty/error/notice/loading
  states). Mounted at /feed in src/index.ts. Principal resolution reuses the
  C1a membership-validation core via headers, query params, or form fields.
  Tests in src/ui/feed.test.ts cover create-post-appears-in-feed, feed
  ordering follows API order (including a bumped older post), and unsafe
  HTML/script escaping on feed and post-creation surfaces. Gate fixes removed
  root-mounted JSON auth interception for /feed, aligned browser form principal
  fields with C1a validation, adjusted escaped-HTML assertions, and mapped
  write-scope denials to 403 HTML errors. Orchestrator verified `npm install`,
  `npm test` (163 tests), `npm run build`, `npm run lint`, and
  `npm run typecheck`. C4 is `done`.
- 2026-06-27 — Chunk C5: not started -> done — Implemented server-rendered post detail UI at `/feed/:postId`, first-level comments, nested replies, reply composers, reply-target context, deep-tree collapse/safeguard, shared UI principal helpers, C3a rendering for comment/reply surfaces, index mount, and C5 UI tests for correct reply placement, feed bump after replying to an old post, nested sanitization, deep-tree safeguard, cross-post reply rejection, and first-level composer. Orchestrator verified `npm install`, `npm test` (171 tests), `npm run build`, `npm run lint`, and `npm run typecheck` after review fixes. C5 is `done`.
- 2026-06-27 — Chunk C6: not started -> done — Implemented dependency-free
  fenced code highlighting, copy affordance, sanitized preview endpoint, and
  code-block CSS/scripts on top of the C3a renderer; preserved formatting in
  nested replies and kept code-block content escaped/sanitized. Orchestrator
  verified `npm install`, `npm test` (192 tests), `npm run build`,
  `npm run lint`, and `npm run typecheck` after test and review fixes. C6 is `done`.

- 2026-06-27 — Chunk C7: not started -> in progress — Implementation
  complete in worktree `chunk/C7`. Added migration 0003 (agent_profile,
  agent_credential, agent_audit_log, agent_idempotency_key, agent_quota_state)
  with workspace-boundary composite FKs and an agent-kind trigger guard. Agent
  identity reuses the C1 actor kind='agent' (no bot-message table, actor schema
  untouched). Security modules under src/security/: credentials (scrypt+salt
  hashed, one-time plaintext at issuance/rotation, verify/rotate/revoke),
  agentProfile (agent-specific metadata), audit (append-only write log),
  idempotency (durable key store + request digest), rateLimit (per-actor
  rolling-window quota, QuotaExceededError → 429), agentPrincipal (Bearer
  token → agent Principal via membership). Agent control-plane service + routes
  under src/api/ (agentService.ts wraps C2 PostService + C3 CommentService with
  idempotency/audit/quota and exposes machine-readable status metadata;
  agentRoutes.ts mounted at /agents). Updated src/index.ts AppDeps to carry the
  db connection for C7 repositories. Tests in src/api/agentRoutes.test.ts cover
  agent reply bump parity, credential lifecycle (hashed storage, one-time
  issuance, rotation, revocation, cross-workspace rejection), audit logging for
  create post/comment/reply, rate-limit/quota enforcement (429, no duplicate
  write/bump), idempotency (no duplicate reply/bump on replay), metadata
  redaction (no cross-workspace leakage), and migration 0003 apply/rollback.
  Pending orchestrator verification before marking `[x]`.
- 2026-06-27 — Chunk C7: completion pass in
  `/root/gitfiles/Slack-that-Theo-wants-C7` — Registered migration 0003,
  exported C7 security/API modules, restored app DB bootstrap for /agents,
  enforced required idempotency keys on agent HTTP writes, tightened
  credential/profile agent-kind triggers and idempotency-key scoping, and added
  the missing idempotency-required API test. Orchestrator verified `npm install`,
  `npm test` (240 tests), `npm run build`, `npm run lint`, and
  `npm run typecheck` after gate and review fixes. C7 is `done`.
- 2026-06-27 — Chunk C7: review-fix pass in
  `/root/gitfiles/Slack-that-Theo-wants-C7` — Applied blocking review fixes:
  idempotency replay now computes the current request digest and rejects a
  reused key with a different payload via `IdempotencyKeyReuseError` (422
  `idempotency_key_reuse`) with no write/bump/audit; rate limit replaced the
  fixed wall-clock bucket with a true rolling/sliding-window event log in
  `agent_quota_state` (count writes in the trailing `windowMs`, atomic
  count+insert transaction) so the quota holds at every instant across bucket
  boundaries; agent reply route maps `DeletedParentError` to 409
  `deleted_parent` like the human C3 route; and cross-workspace
  `workspace_mismatch` on agent read/status/metadata routes is translated to a
  generic redacted 404 `not_found` with no target workspace identifier. Added
  tests for idempotency-key reuse, rolling-window boundary behavior, and
  deleted-parent agent replies; tightened the cross-workspace readStatus/readPost
  redaction assertions. Final redaction-parity fix made true not-found and
  cross-workspace agent resource misses return identical generic 404 bodies.
  Orchestrator reverified `npm test` (240 tests), `npm run build`,
  `npm run lint`, and `npm run typecheck`. C7 remains `done`.