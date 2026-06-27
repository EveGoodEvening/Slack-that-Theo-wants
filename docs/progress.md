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
| C2    | not started  | Depends on C1, C1a |
| C3    | not started  | Depends on C1, C1a |
| C3a   | not started  | Depends on C0; prerequisite for C4/C5 |
| C4    | not started  | Depends on C2, C3a |
| C5    | not started  | Depends on C3, C4, C3a |
| C6    | not started  | Depends on C3a, C4, C5 |
| C7    | not started  | Depends on C1, C1a, C2, C3 |
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

- [ ] Define service interface for post creation and feed listing
- [ ] Implement create-post endpoint (author, workspace/group, content, initial `lastActivityAt`)
- [ ] Implement list-feed endpoint ordered by `lastActivityAt` descending
- [ ] Implement read-post endpoint returning post + comment-tree metadata
- [ ] Enforce workspace/group boundary on every endpoint via the C1a authorization middleware (even before real sign-in)
- [ ] Enforce feed listing scope by applying the C1a workspace/group filter helper before ordering/pagination
- [ ] Add cursor-based pagination for the feed with a deterministic order: `lastActivityAt DESC, postId DESC` (or the stack's stable unique-key equivalent); the cursor encodes this composite order so equal timestamps never produce duplicate or skipped posts
- [ ] Add API tests: newest post ordering, old post bumps after C1-seeded comment activity (data-layer bump via the shared C1 bump helper), empty state, pagination cursor behavior including multiple posts sharing the same `lastActivityAt`, cross-workspace rejection, feed listings exclude posts outside the principal's workspace/group

## C3 — Comment/reply API with unlimited nesting

- [ ] Define service interface for comment/reply creation and subtree fetch
- [ ] Implement create first-level comment on a post
- [ ] Implement create reply to any comment (arbitrary depth)
- [ ] Preserve `replyToActorId` / target context so users can reply to different people without clogging the main post
- [ ] Implement fetch-subtree and fetch-full-thread endpoints
- [ ] Ensure every reply triggers the shared C1 atomic `lastActivityAt` bump helper on the root post (no duplicate implementation)
- [ ] Define deleted-parent behavior: reject replies to a soft-deleted parent (cannot reply into a deleted subtree); fetching a subtree containing a deleted node returns a tombstone placeholder (redacted author/content) while preserving retrievable children
- [ ] Define stable sibling ordering for replies under the same parent (e.g., `createdAt ASC, nodeId ASC`)
- [ ] Enforce workspace/group boundary on every endpoint via the C1a authorization middleware
- [ ] Add API tests: arbitrary-depth insertion, invalid/missing parent rejection, deleted-parent behavior (reply rejected + tombstone with children preserved), sibling ordering, feed bump side effect on every nested reply

## C3a — Safe content rendering baseline

- [ ] Choose and record rendering strategy (markdown library, rich-text, or custom)
- [ ] Implement safe HTML sanitization/escaping (no script execution) for post/comment/reply content
- [ ] Provide a reusable render function/component consumed by C4 and C5
- [ ] Add tests: injected `<script>`/unsafe HTML does not execute through the renderer; content is escaped/sanitized on every render path

## C4 — Minimal human UI: feed and post creation

- [ ] Implement feed/landing view consuming the C2 list-feed endpoint
- [ ] Render post cards ordered by API response order (do not re-sort client-side)
- [ ] Render all post content through the C3a safe renderer/sanitizer (never render raw stored content)
- [ ] Implement create-post form calling the C2 create endpoint
- [ ] Add loading, error, and empty states
- [ ] Add component or E2E test proving creating a post appears in the feed
- [ ] Add test proving feed ordering follows the API order
- [ ] Add test proving unsafe HTML/script in post content is escaped/sanitized on the feed and post-creation surfaces (via the C3a renderer)

## C5 — Conversation UI: first-level comments and nested replies

- [ ] Implement post detail view consuming C2 read-post and C3 subtree endpoints
- [ ] Render first-level comments inline under the post
- [ ] Implement nested reply composer on each comment/reply
- [ ] Implement indentation and collapse strategy for deep trees (with rendering safeguard for very deep nesting)
- [ ] Show reply-target context (who is being replied to) without clogging the main post
- [ ] Render all comment/reply content through the C3a safe renderer/sanitizer (never render raw stored content)
- [ ] Add E2E test proving replying to different comments renders in the correct location
- [ ] Add E2E test proving a reply on an old post bumps it to the top of the feed
- [ ] Add test proving unsafe HTML/script in comment/reply content is escaped/sanitized on every nested reply surface (via the C3a renderer)

## C6 — Code block / message authoring experience

- [ ] Implement fenced code block rendering with syntax highlighting and copy affordance (on top of the C3a renderer)
- [ ] Ensure code formatting is preserved inside nested replies
- [ ] Add optional preview mode if desired
- [ ] Add tests: code fences render as code, code formatting preserved in nested replies, code-block content is still sanitized (defense-in-depth via C3a)

## C7 — Agent identity and API control plane

- [ ] Use the existing C1 human/agent actor type for agent identity (no separate bot-message table); add only agent-specific profile/metadata fields. The actor schema itself is owned by C1 and must not be re-defined here
- [ ] Implement scoped API tokens or service credentials for agents, stored hashed (never plaintext), with one-time secret display at issuance
- [ ] Implement credential rotation and revocation
- [ ] Add audit logging for agent write actions (create post/comment/reply)
- [ ] Add rate limits/quotas for agent API calls
- [ ] Require idempotency keys for agent create-post/comment/reply calls to prevent duplicate replies and extra bumps on retry/replay
- [ ] Expose endpoints for agents to create posts/comments/replies using the same C2/C3 services, routed through the C1a authorization middleware
- [ ] Expose machine-readable feed polling or event subscription endpoint with least-privilege/redaction for agent callers
- [ ] Define and expose a machine-readable priority/status metadata contract (per-post `lastActivityAt`, reply count, active/unresolved status, actor type) ordered by activity, so agents can infer priorities without scraping UI text
- [ ] Redact/least-privilege scope feed, event, and status metadata APIs for agent callers (no cross-workspace leakage)
- [ ] Add API tests proving an agent can join a post/comment tree and its replies bump posts identically to human replies; credential lifecycle (hashed storage, one-time issuance, rotation, revocation); audit logging for create post/comment/reply; rate-limit/quota enforcement; idempotency (no duplicate reply/bump on replay); metadata redaction; related migration apply/rollback for any C7 persistent security structures

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
