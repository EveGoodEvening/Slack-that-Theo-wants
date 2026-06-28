# Todo / Implementation Checklist: Slack That Theo Wants

This checklist is written for a coding agent implementing the reference design step by step. Complete items in order unless explicitly marked optional. Do not start Slack integration before the core post/comment/feed model is working.

---

## 0. Working assumptions

- Stack: TypeScript monorepo.
- Frontend: React web app, preferably Next.js or Vite.
- Backend: Node.js API service.
- Database: PostgreSQL.
- Cache/jobs/realtime fanout: Redis.
- Object storage: S3-compatible, MinIO locally.
- Realtime: WebSocket or SSE; WebSocket preferred.
- Editor: TipTap/ProseMirror, Lexical, or an equivalent structured editor.
- Tests: Vitest/Jest for unit/integration, Playwright for browser E2E.
- All content authors are `actors`; humans and agents must share the same authoring path.

---

## 1. Repository and local development setup

### 1.1 Initialize repo

- [ ] Create a monorepo.
- [ ] Add package manager config, preferably `pnpm-workspace.yaml`.
- [ ] Add TypeScript base config.
- [ ] Add lint config.
- [ ] Add formatter config.
- [ ] Add `.editorconfig`.
- [ ] Add `.gitignore`.
- [ ] Add root scripts:
  - [ ] `dev`
  - [ ] `build`
  - [ ] `test`
  - [ ] `test:unit`
  - [ ] `test:integration`
  - [ ] `test:e2e`
  - [ ] `lint`
  - [ ] `typecheck`
  - [ ] `db:migrate`
  - [ ] `db:seed`

### 1.2 Create package layout

- [ ] Create `apps/web`.
- [ ] Create `apps/api`.
- [ ] Create `apps/worker` or worker entrypoint under `apps/api`.
- [ ] Create `packages/db`.
- [ ] Create `packages/shared`.
- [ ] Create `packages/ui` if using shared UI components.
- [ ] Create `packages/config` for shared environment parsing.
- [ ] Create `packages/test-utils`.

### 1.3 Add local infrastructure

- [ ] Add `infra/docker-compose.yml` with:
  - [ ] PostgreSQL.
  - [ ] Redis.
  - [ ] MinIO or equivalent object storage.
  - [ ] Mailpit or equivalent local email sink.
- [ ] Add `.env.example` with all required variables.
- [ ] Add startup docs in `README.md`.
- [ ] Verify `docker compose up` starts dependencies.
- [ ] Verify API can connect to PostgreSQL and Redis.
- [ ] Verify web app can call API health endpoint.

### 1.4 CI setup

- [ ] Add CI workflow.
- [ ] Install dependencies in CI.
- [ ] Run lint.
- [ ] Run typecheck.
- [ ] Run unit tests.
- [ ] Run database migrations against a temporary PostgreSQL service.
- [ ] Run integration tests.
- [ ] Upload test artifacts for failed Playwright runs once E2E exists.

Acceptance:

- [ ] A fresh clone can run the app locally using documented commands.
- [ ] CI fails on lint, type, migration, or test errors.

---

## 2. Shared primitives

### 2.1 Environment config

- [ ] Implement typed environment variable parsing.
- [ ] Validate required variables at service boot.
- [ ] Separate configs for development, test, and production.
- [ ] Ensure secrets are never logged.

### 2.2 ID helpers

- [ ] Choose UUIDv7, ULID, or database-generated UUIDs.
- [ ] Add helper for generating IDs if application-generated.
- [ ] Add validation helper for public route params.
- [ ] Add tests for ID parsing and validation.

### 2.3 Request context

- [ ] Implement request ID middleware.
- [ ] Attach authenticated actor to request context.
- [ ] Attach tenant context to request context.
- [ ] Add structured logging middleware.
- [ ] Add error envelope middleware.

### 2.4 API schema conventions

- [ ] Add runtime schema validation library.
- [ ] Define pagination schema.
- [ ] Define error schema.
- [ ] Define idempotency key schema.
- [ ] Generate or maintain OpenAPI docs.

Acceptance:

- [ ] Invalid requests return consistent `400` errors.
- [ ] Unauthorized requests return consistent `401` errors.
- [ ] Forbidden requests return consistent `403` errors.
- [ ] Every response includes or logs a request ID.

---

## 3. Database foundation

### 3.1 Migration setup

- [ ] Pick and configure migration tool.
- [ ] Add migration command.
- [ ] Add rollback or forward-fix policy.
- [ ] Add test database reset command.

### 3.2 PostgreSQL extensions

- [ ] Enable `pgcrypto`.
- [ ] Enable `ltree`.
- [ ] Enable `pg_trgm`.
- [ ] Enable `citext` or implement lowercase email uniqueness.
- [ ] Optionally enable `unaccent`.

### 3.3 Core enum migrations

- [ ] Add `actor_type` enum.
- [ ] Add `org_role` enum.
- [ ] Add `group_visibility` enum.
- [ ] Add `shared_group_role` enum.
- [ ] Add `group_role` enum.
- [ ] Add `post_status` enum.
- [ ] Add `assignment_status` enum.
- [ ] Add `agent_run_status` enum.

### 3.4 Core table migrations

- [ ] Create `tenants`.
- [ ] Create `organizations`.
- [ ] Create `actors`.
- [ ] Create `users`.
- [ ] Create `organization_memberships`.
- [ ] Create `groups`.
- [ ] Create `group_organizations`.
- [ ] Create `group_memberships`.
- [ ] Create `posts`.
- [ ] Create `comments`.
- [ ] Create `reactions`.
- [ ] Create `mentions`.
- [ ] Create `post_read_states`.
- [ ] Create `post_subscriptions`.
- [ ] Create `notifications`.
- [ ] Create `attachments`.
- [ ] Create `content_attachments`.
- [ ] Create `assignments`.
- [ ] Create `audit_events`.

### 3.5 Agent and integration migrations

- [ ] Create `agents`.
- [ ] Create `agent_installations`.
- [ ] Create `agent_runs`.
- [ ] Create `agent_run_steps`.
- [ ] Create `integrations`.
- [ ] Create `external_mappings`.

### 3.6 Search migrations

- [ ] Create `search_documents`.
- [ ] Add GIN index on `search_vector`.
- [ ] Add access-filter indexes for tenant/group.

### 3.7 Index review

- [ ] Add posts feed index by group and activity.
- [ ] Add posts feed index by tenant and activity.
- [ ] Add comments path index.
- [ ] Add comments parent/sibling index.
- [ ] Add notifications unread index.
- [ ] Add assignments assignee/status index.
- [ ] Add external mapping uniqueness index.

Acceptance:

- [ ] Migrations run from empty database.
- [ ] Migrations are idempotent in CI setup.
- [ ] Integration tests can reset and seed the database.

---

## 4. Authentication and initial tenant setup

### 4.1 Sessions

- [ ] Implement password-based login for local/MVP use or a simple OAuth provider if preferred.
- [ ] Store password hashes using a modern password hashing algorithm.
- [ ] Implement secure session creation.
- [ ] Set HTTP-only secure cookies.
- [ ] Add CSRF protection if cookie auth is used.
- [ ] Implement logout.
- [ ] Implement `GET /auth/session`.

### 4.2 Bootstrap flow

- [ ] On first run, allow creation of first tenant.
- [ ] Create first organization.
- [ ] Create first human actor.
- [ ] Create first user.
- [ ] Add first user as organization owner.
- [ ] Create default groups:
  - [ ] `general`
  - [ ] `announcements`
  - [ ] `agents`
- [ ] Add owner to default groups.

### 4.3 User invitations

- [ ] Implement invitation model or reuse existing table if added.
- [ ] Create invitation endpoint.
- [ ] Send local email through Mailpit in dev.
- [ ] Accept invitation flow.
- [ ] Create user actor on accept.
- [ ] Add membership to organization and selected groups.

Acceptance:

- [ ] First user can create the workspace.
- [ ] First user can invite a second user.
- [ ] Second user can log in and see default groups.

---

## 5. Authorization module

### 5.1 Central permission API

- [ ] Create `can(actor, action, resource)` function.
- [ ] Create typed action constants.
- [ ] Implement tenant boundary check.
- [ ] Implement organization role checks.
- [ ] Implement group membership checks.
- [ ] Implement resource state checks for archived/locked/deleted.
- [ ] Implement agent scope checks.
- [ ] Implement shared group organization checks.

### 5.2 Middleware and service guards

- [ ] Add route-level auth guard.
- [ ] Add service-level authorization guard.
- [ ] Ensure every read endpoint checks access.
- [ ] Ensure every mutation endpoint checks access.
- [ ] Ensure every background job re-checks access before delivering sensitive data.

### 5.3 Permission tests

- [ ] Test owner can manage group.
- [ ] Test member can post/comment.
- [ ] Test viewer can read but not comment.
- [ ] Test non-member cannot read private group.
- [ ] Test external user can read only shared group membership.
- [ ] Test agent cannot exceed installation scopes.
- [ ] Test locked post blocks normal comments.

Acceptance:

- [ ] No API handler accesses protected content without calling the authorization module.
- [ ] Search and realtime also enforce authorization.

---

## 6. Groups and memberships

### 6.1 Backend endpoints

- [ ] Implement `POST /groups`.
- [ ] Implement `GET /groups`.
- [ ] Implement `GET /groups/:groupId`.
- [ ] Implement `PATCH /groups/:groupId`.
- [ ] Implement `DELETE /groups/:groupId` or archive behavior.
- [ ] Implement `GET /groups/:groupId/members`.
- [ ] Implement `POST /groups/:groupId/members`.
- [ ] Implement `PATCH /groups/:groupId/members/:actorId`.
- [ ] Implement `DELETE /groups/:groupId/members/:actorId`.

### 6.2 Frontend pages

- [ ] Add group list page.
- [ ] Add create group form.
- [ ] Add group settings page.
- [ ] Add group members page.
- [ ] Add group header component.

### 6.3 Group behavior

- [ ] Enforce unique group slugs per tenant.
- [ ] Add group visibility badge.
- [ ] Add archived group state.
- [ ] Prevent posting to archived group.
- [ ] Add default notification level per membership.

Acceptance:

- [ ] User can create a private group.
- [ ] User can add/remove members.
- [ ] Non-member cannot see private group.
- [ ] Member can see group in navigation.

---

## 7. Content editor and renderer

### 7.1 Content schema

- [ ] Define canonical `content_json` schema.
- [ ] Define Markdown serialization.
- [ ] Define Markdown deserialization if needed.
- [ ] Add server-side validation for max size.
- [ ] Add sanitizer for rendered output.
- [ ] Add tests for malicious HTML/script stripping.

### 7.2 Editor MVP

- [ ] Add rich text editor component.
- [ ] Add Markdown shortcuts.
- [ ] Add inline code.
- [ ] Add fenced code block support.
- [ ] Add language selector for code blocks.
- [ ] Add block quote.
- [ ] Add bullet list.
- [ ] Add numbered list.
- [ ] Add checklist if editor supports it.
- [ ] Add link insertion.
- [ ] Add mention trigger UI for users/agents.

### 7.3 Code block renderer

- [ ] Render fenced code blocks with syntax highlighting.
- [ ] Add copy button.
- [ ] Add line wrap toggle.
- [ ] Add optional line numbers.
- [ ] Add diff block support.
- [ ] Preserve whitespace exactly.
- [ ] Add tests for pasted code blocks.

### 7.4 Drafts

- [ ] Store local draft for new post per group.
- [ ] Store local draft for comment per post/comment target.
- [ ] Recover draft after refresh.
- [ ] Clear draft after successful submit.

Acceptance:

- [ ] User can paste a multi-line code block and submit it.
- [ ] Rendered code block preserves indentation.
- [ ] User can copy code from rendered block.
- [ ] Editor output is safe against script injection.

---

## 8. Posts and feed

### 8.1 Backend post service

- [ ] Implement create post transaction.
- [ ] Validate group write permission.
- [ ] Parse mentions from post content.
- [ ] Create default subscription for post author.
- [ ] Insert search document.
- [ ] Emit `post.created` activity event.
- [ ] Publish realtime event.
- [ ] Enqueue notifications.

### 8.2 Backend post endpoints

- [ ] Implement `POST /posts`.
- [ ] Implement `GET /posts/:postId`.
- [ ] Implement `PATCH /posts/:postId`.
- [ ] Implement `DELETE /posts/:postId` soft delete.
- [ ] Implement `POST /posts/:postId/resolve`.
- [ ] Implement `POST /posts/:postId/reopen`.
- [ ] Implement `POST /posts/:postId/pin`.
- [ ] Implement `POST /posts/:postId/read`.
- [ ] Implement `POST /posts/:postId/subscribe`.
- [ ] Implement `DELETE /posts/:postId/subscribe` or set muted.

### 8.3 Feed queries

- [ ] Implement group feed query ordered by pin rank and `activity_at DESC`.
- [ ] Implement home feed query across readable groups.
- [ ] Implement cursor pagination.
- [ ] Include viewer unread state in feed response.
- [ ] Include last activity actor in feed response.
- [ ] Include comment count.
- [ ] Include assignment summary.

### 8.4 Frontend feed UI

- [ ] Build post card component.
- [ ] Build home feed page.
- [ ] Build group feed page.
- [ ] Add cursor pagination/infinite scroll or load more.
- [ ] Add unread badge.
- [ ] Add comment count.
- [ ] Add participant avatars.
- [ ] Add post status badge.
- [ ] Add last activity line.

### 8.5 Post detail UI

- [ ] Build post detail route.
- [ ] Render post header.
- [ ] Render post body.
- [ ] Add resolve/reopen action.
- [ ] Add follow/mute action.
- [ ] Add mark-read behavior.

Acceptance:

- [ ] Creating a post shows it at top of group feed.
- [ ] Post appears in home feed for group members.
- [ ] Unauthorized user cannot fetch post by ID.
- [ ] Resolving a post changes status without deleting comments.

---

## 9. Nested comments

### 9.1 Comment path allocation

- [ ] Implement sibling ordinal allocation inside a transaction.
- [ ] Implement root comment path generation.
- [ ] Implement child comment path generation from parent path.
- [ ] Validate parent comment belongs to same post.
- [ ] Compute depth from parent.
- [ ] Add tests for root paths.
- [ ] Add tests for nested paths.
- [ ] Add concurrent insertion test under same parent.

### 9.2 Create comment service

- [ ] Validate post read/write permissions.
- [ ] Validate post is not locked/archived.
- [ ] Insert comment.
- [ ] Update post `comment_count`.
- [ ] Apply bump policy.
- [ ] Update post `activity_at` for meaningful comments.
- [ ] Set `last_activity_actor_id`.
- [ ] Set `last_comment_id`.
- [ ] Parse mentions.
- [ ] Create activity event.
- [ ] Enqueue notifications.
- [ ] Enqueue search indexing.
- [ ] Enqueue agent event delivery if relevant.
- [ ] Publish realtime event.

### 9.3 Comment endpoints

- [ ] Implement `GET /posts/:postId/comments` tree mode.
- [ ] Implement `GET /posts/:postId/comments` flat mode.
- [ ] Implement `POST /posts/:postId/comments`.
- [ ] Implement `GET /comments/:commentId`.
- [ ] Implement `PATCH /comments/:commentId`.
- [ ] Implement `DELETE /comments/:commentId` soft delete.

### 9.4 Comment UI

- [ ] Build comment component.
- [ ] Add nested reply rendering.
- [ ] Add reply button on every comment.
- [ ] Add inline reply composer.
- [ ] Add collapse/expand branch.
- [ ] Add “show more replies”.
- [ ] Add focused branch view for deep nesting.
- [ ] Add deleted comment tombstone.
- [ ] Add edited indicator.

### 9.5 Bump tests

- [ ] Create two posts.
- [ ] Comment on older post.
- [ ] Assert older post moves above newer inactive post.
- [ ] Add reaction and assert it does not bump.
- [ ] Edit comment and assert it does not bump by default.
- [ ] Add agent visible comment and assert it bumps.
- [ ] Add silent import comment and assert it does not bump.

Acceptance:

- [ ] User can reply to a specific comment.
- [ ] Nested reply appears under that comment.
- [ ] Any normal new comment bumps parent post to top.
- [ ] Deep branches remain navigable.

---

## 10. Reactions

### 10.1 Backend

- [ ] Implement add reaction to post.
- [ ] Implement remove reaction from post.
- [ ] Implement add reaction to comment.
- [ ] Implement remove reaction from comment.
- [ ] Ensure duplicate reaction is idempotent.
- [ ] Ensure reactions do not bump by default.
- [ ] Publish realtime reaction event.

### 10.2 Frontend

- [ ] Add reaction picker.
- [ ] Add common emoji quick reactions.
- [ ] Display reaction counts.
- [ ] Show viewer reaction state.
- [ ] Update optimistically and reconcile.

Acceptance:

- [ ] User can react to post/comment.
- [ ] Reaction count updates realtime.
- [ ] Reaction does not reorder feed.

---

## 11. Mentions, notifications, and read state

### 11.1 Mention parsing

- [ ] Define mention token format in content JSON.
- [ ] Parse user mentions.
- [ ] Parse agent mentions.
- [ ] Parse group mentions.
- [ ] Validate mentioned actors are visible to author.
- [ ] Store mentions rows.
- [ ] Add tests for invalid/inaccessible mention targets.

### 11.2 Notification recipient logic

- [ ] Notify post author on new root comment unless muted/self-authored.
- [ ] Notify comment author on direct nested reply unless muted/self-authored.
- [ ] Notify mentioned actors.
- [ ] Notify assignees on assignment changes.
- [ ] Notify followers based on subscription level.
- [ ] Do not notify muted actors.
- [ ] Deduplicate notifications for same recipient/source.

### 11.3 Notification backend

- [ ] Implement notification job.
- [ ] Implement `GET /notifications`.
- [ ] Implement mark one notification read.
- [ ] Implement mark all read.
- [ ] Add unread count endpoint or include in session bootstrap.
- [ ] Publish realtime notification events.

### 11.4 Read state

- [ ] Mark post read when post detail is opened and comments are loaded.
- [ ] Store `last_read_activity_at`.
- [ ] Store `last_read_comment_count`.
- [ ] Compute unread feed state.
- [ ] Add “jump to first unread” helper.

### 11.5 Frontend

- [ ] Add notification bell/inbox.
- [ ] Add unread badges in feed.
- [ ] Add mentions page.
- [ ] Add assigned page placeholder if assignments not complete yet.
- [ ] Add group notification setting.
- [ ] Add post follow/mute UI.

Acceptance:

- [ ] Mentioned user receives notification.
- [ ] Reply target receives notification.
- [ ] Muted user does not receive notification.
- [ ] Opening a post clears unread state for that post.

---

## 12. Realtime

### 12.1 Server transport

- [ ] Implement WebSocket or SSE endpoint.
- [ ] Authenticate connection.
- [ ] Load actor and readable group IDs.
- [ ] Subscribe to relevant group/post channels.
- [ ] Add heartbeat/ping.
- [ ] Handle reconnect.
- [ ] Add event sequence or timestamp for gap detection.

### 12.2 Redis fanout

- [ ] Publish post events to Redis.
- [ ] Publish comment events to Redis.
- [ ] Publish notification events to Redis.
- [ ] Publish assignment events to Redis.
- [ ] Publish agent run events to Redis.
- [ ] API nodes subscribe and forward to connected clients.

### 12.3 Client behavior

- [ ] Connect on app load after auth.
- [ ] Reconnect with backoff.
- [ ] On `post.bumped`, update feed ordering.
- [ ] On `comment.created`, insert comment if post is open.
- [ ] On missed/gap event, refetch feed/post.
- [ ] Avoid duplicating optimistic updates.

Acceptance:

- [ ] Comment appears realtime in another user's browser.
- [ ] Feed reorders realtime when a post is bumped.
- [ ] Unauthorized users do not receive events for private groups.

---

## 13. Search

### 13.1 Indexing

- [ ] Implement search document generation for posts.
- [ ] Implement search document generation for comments.
- [ ] Update search document on edit.
- [ ] Soft-delete search document on content delete.
- [ ] Add background job processor.
- [ ] Add reindex command.

### 13.2 Query endpoint

- [ ] Implement `GET /search`.
- [ ] Parse query string safely.
- [ ] Filter by tenant.
- [ ] Join/filter by readable group membership.
- [ ] Support type filter.
- [ ] Support group filter.
- [ ] Support status filter.
- [ ] Support cursor pagination.

### 13.3 Frontend

- [ ] Add search input.
- [ ] Add search results page.
- [ ] Show post/comment result context.
- [ ] Link comment result to exact post/comment anchor.
- [ ] Highlight matched terms where safe.

Acceptance:

- [ ] Search finds posts by title.
- [ ] Search finds comments by body.
- [ ] Search never returns inaccessible private/shared group content.

---

## 14. Assignments

### 14.1 Backend

- [ ] Implement create assignment.
- [ ] Assign to human actor.
- [ ] Assign to agent actor.
- [ ] Link assignment to post and optional comment.
- [ ] Implement status transitions.
- [ ] Validate assignee can access target post.
- [ ] Bump post on meaningful status changes.
- [ ] Create notifications.
- [ ] Publish realtime events.
- [ ] Audit assignment changes if agent-related.

### 14.2 Frontend

- [ ] Add assign action on post.
- [ ] Add assign action on comment.
- [ ] Add assignment badge to feed card.
- [ ] Add assignment panel on post detail.
- [ ] Add Assigned page.
- [ ] Add status transition UI.

Acceptance:

- [ ] User can assign a post to another user.
- [ ] User can assign a comment to an agent.
- [ ] Assignee sees item in Assigned page.
- [ ] Marking assignment done can bump the post.

---

## 15. Agent MVP

### 15.1 Actor support for agents

- [ ] Ensure posts/comments can be authored by any actor type.
- [ ] Create `agent` actor creation flow.
- [ ] Create `agents` table service.
- [ ] Render agent badge in UI.
- [ ] Add agent profile page.

### 15.2 Agent registration

- [ ] Implement `POST /agents`.
- [ ] Validate agent manifest.
- [ ] Store requested scopes.
- [ ] Store webhook URL if provided.
- [ ] Generate or register signing key.
- [ ] Create agent actor.

### 15.3 Agent installation

- [ ] Implement install agent to organization.
- [ ] Implement install agent to group.
- [ ] Implement install agent to post if desired.
- [ ] Validate installer permissions.
- [ ] Store granted scopes.
- [ ] Allow admin to disable/revoke installation.
- [ ] Audit install/revoke/scope changes.

### 15.4 Agent mentions

- [ ] Include agents in mention autocomplete.
- [ ] On comment/post creation, detect agent mentions.
- [ ] Check agent installation exists for target context.
- [ ] Create agent run or event.
- [ ] Notify/trigger agent worker.

### 15.5 Agent runs

- [ ] Implement `POST /agent-runs`.
- [ ] Implement `GET /agent-runs/:runId`.
- [ ] Implement `POST /agent-runs/:runId/cancel`.
- [ ] Implement run status transitions.
- [ ] Implement run cards in post detail.
- [ ] Publish realtime run status.

### 15.6 Agent comments

- [ ] Implement `POST /agent-runs/:runId/comment`.
- [ ] Ensure run's agent has `comments:write`.
- [ ] Ensure run is scoped to target post/comment.
- [ ] Create comment as agent actor.
- [ ] Apply bump policy.
- [ ] Link comment to run step.

### 15.7 Test agent

- [ ] Create local echo/summarizer test agent.
- [ ] Test `@agent` mention.
- [ ] Test agent receives context.
- [ ] Test agent posts nested reply.
- [ ] Test agent run card updates.
- [ ] Test revoking agent prevents future access.

Acceptance:

- [ ] A human can mention an installed agent.
- [ ] Agent receives only permitted post/comment context.
- [ ] Agent can reply under the relevant post.
- [ ] Agent reply appears as agent-authored content and bumps the post.

---

## 16. Agent webhooks and external agent API

### 16.1 Signed event delivery

- [ ] Define webhook event envelope.
- [ ] Generate delivery ID.
- [ ] Add timestamp header.
- [ ] Sign payload.
- [ ] Send webhook from worker.
- [ ] Retry with exponential backoff.
- [ ] Respect timeout.
- [ ] Store delivery attempts.
- [ ] Dead-letter repeated failures.

### 16.2 Agent context endpoint

- [ ] Implement `GET /posts/:postId/context?format=json` for agents.
- [ ] Implement `GET /posts/:postId/context?format=markdown` for agents.
- [ ] Enforce agent scopes.
- [ ] Add max comments limit.
- [ ] Add truncation markers.
- [ ] Add branch-specific context fetch.

### 16.3 Agent admin UI

- [ ] List installed agents.
- [ ] Show scopes.
- [ ] Show groups/posts installed into.
- [ ] Show recent runs.
- [ ] Show failed webhook deliveries.
- [ ] Allow disabling installation.

Acceptance:

- [ ] External agent can receive signed events.
- [ ] External agent can post back using scoped API token.
- [ ] Failed deliveries are visible and retryable.

---

## 17. Attachments

### 17.1 Storage backend

- [ ] Configure S3-compatible client.
- [ ] Configure local MinIO.
- [ ] Implement presigned upload endpoint.
- [ ] Implement upload completion endpoint.
- [ ] Store metadata in `attachments`.
- [ ] Link attachment to post/comment/run.

### 17.2 Download authorization

- [ ] Implement authorized download endpoint.
- [ ] Generate short-lived signed download URL.
- [ ] Verify actor can read linked content.
- [ ] Add tests for unauthorized download denial.

### 17.3 Frontend

- [ ] Add file picker.
- [ ] Add drag-and-drop.
- [ ] Add paste upload.
- [ ] Show upload progress.
- [ ] Render attachment list.
- [ ] Render image previews when safe.

Acceptance:

- [ ] User can attach file to post/comment.
- [ ] Authorized user can download.
- [ ] Unauthorized user cannot download by guessing URL.

---

## 18. Cross-company shared groups

Do this after core group/feed/comment behavior is stable.

### 18.1 Organization model

- [ ] Allow creating partner organization inside tenant.
- [ ] Add verified domain or manual trust note.
- [ ] Add organization badge rendering.
- [ ] Add external user invitation flow.

### 18.2 Shared group backend

- [ ] Implement `shared` visibility.
- [ ] Implement `group_organizations` host/partner records.
- [ ] Add endpoint to add partner organization to group.
- [ ] Add endpoint to remove partner organization.
- [ ] Ensure group membership actor organization is allowed.
- [ ] Prevent external org removal if policy requires retention check.
- [ ] Add audit events for share/unshare.

### 18.3 Shared group UI

- [ ] Add shared group creation option.
- [ ] Add external sharing settings page.
- [ ] Show external organization warning in group header.
- [ ] Show actor organization badges on posts/comments.
- [ ] Add confirmation for broad mentions in shared groups.

### 18.4 Shared group tests

- [ ] Host org member can access shared group.
- [ ] Partner org member can access shared group if added.
- [ ] Partner org member cannot access host private groups.
- [ ] External user cannot invite another organization by default.
- [ ] Search respects shared group access.
- [ ] Realtime respects shared group access.

Acceptance:

- [ ] Two organizations can collaborate in one group.
- [ ] All external access is explicit and auditable.

---

## 19. Admin and audit logs

### 19.1 Audit event service

- [ ] Create audit logging helper.
- [ ] Add audit log for login failures if desired.
- [ ] Add audit log for group create/update/archive.
- [ ] Add audit log for member add/remove.
- [ ] Add audit log for external sharing changes.
- [ ] Add audit log for agent install/scope/revoke.
- [ ] Add audit log for content deletion.
- [ ] Add audit log for export/import.

### 19.2 Admin UI

- [ ] Add organization settings page.
- [ ] Add user/member management page.
- [ ] Add group admin page.
- [ ] Add external sharing overview.
- [ ] Add agent admin overview.
- [ ] Add audit log page with filters.

### 19.3 Retention basics

- [ ] Define soft-delete retention window.
- [ ] Add cleanup job for hard-deleted attachments after retention.
- [ ] Add export command for post/group.
- [ ] Document backup and restore.

Acceptance:

- [ ] Admin can answer: who shared this group externally, when, and with whom?
- [ ] Admin can answer: which agents are installed and what can they access?

---

## 20. Slack import and bridge

Do this only after the native app works. Keep all Slack behavior optional and isolated behind integration modules.

### 20.1 Slack app setup

- [ ] Create Slack integration provider module.
- [ ] Add Slack OAuth config.
- [ ] Store Slack integration record.
- [ ] Store secrets in secret manager or encrypted secret reference.
- [ ] Add admin UI to connect Slack workspace.
- [ ] Add admin UI to select channels for import/bridge.

### 20.2 External mappings

- [ ] Map Slack workspace to tenant/organization.
- [ ] Map Slack channel to group.
- [ ] Map Slack user to actor/user placeholder.
- [ ] Map Slack bot to actor/agent placeholder.
- [ ] Map Slack message timestamp to post/comment.
- [ ] Add idempotent upsert helpers.

### 20.3 Historical import

- [ ] Implement channel listing job.
- [ ] Implement conversation history paging with checkpoints.
- [ ] Implement thread replies paging with checkpoints.
- [ ] Respect provider rate limits and `Retry-After`.
- [ ] Convert Slack thread roots to posts.
- [ ] Convert Slack thread replies to comments.
- [ ] Convert files to attachments where permitted.
- [ ] Convert reactions.
- [ ] Default imports to `bump_policy = silent`.
- [ ] Show import progress in admin UI.
- [ ] Allow import resume after failure.

### 20.4 Notification bridge to Slack

- [ ] Add per-group Slack destination config.
- [ ] On post created or bumped, enqueue Slack notification if enabled.
- [ ] Send concise summary and canonical app link.
- [ ] Avoid mirroring entire nested trees.
- [ ] Rate limit outgoing Slack messages.
- [ ] Add failure visibility.

### 20.5 Optional Socket Mode/event bridge

- [ ] Add Socket Mode connection worker if enabled.
- [ ] Subscribe to supported Slack events.
- [ ] Validate event payloads.
- [ ] Map incoming Slack messages to posts/comments.
- [ ] Use idempotency keys from Slack event IDs/timestamps.
- [ ] Handle disconnect/reconnect.
- [ ] Expose connection status in admin UI.

Acceptance:

- [ ] Admin can import a Slack channel into a group.
- [ ] Threaded Slack discussions appear as post/comment trees.
- [ ] Historical imports do not flood active feeds.
- [ ] Slack bridge failures do not break native app workflows.

---

## 21. Exports and open data format

### 21.1 Post export

- [ ] Implement export post as Markdown.
- [ ] Include nested comments in logical tree order.
- [ ] Include actor names and timestamps.
- [ ] Include attachments manifest.
- [ ] Include agent run summaries.

### 21.2 Group export

- [ ] Implement group export job.
- [ ] Export posts as Markdown files.
- [ ] Export JSON manifest.
- [ ] Export attachment manifest.
- [ ] Include membership metadata.

### 21.3 Import format

- [ ] Define JSON schema for native import.
- [ ] Support importing exported posts/comments.
- [ ] Preserve external IDs if present.
- [ ] Default imported content to silent activity unless configured.

Acceptance:

- [ ] A post can round-trip through export/import in a test tenant.
- [ ] Exported Markdown preserves nested reply structure.

---

## 22. Accessibility and keyboard support

### 22.1 Accessibility baseline

- [ ] Use semantic HTML for feeds, posts, comments, and buttons.
- [ ] Ensure keyboard access to all actions.
- [ ] Add visible focus states.
- [ ] Add ARIA labels where needed.
- [ ] Test with screen reader basics.
- [ ] Ensure color contrast meets WCAG AA.

### 22.2 Keyboard shortcuts

- [ ] `c` or equivalent to create post when feed focused.
- [ ] `r` to reply when comment focused.
- [ ] `j/k` or arrow navigation through feed items if desired.
- [ ] `Cmd/Ctrl+Enter` to submit composer.
- [ ] `Esc` to close inline composer.

Acceptance:

- [ ] User can create and reply without mouse.
- [ ] Focus does not get lost after submitting a comment.

---

## 23. Performance and load testing

### 23.1 Seed data

- [ ] Create seed script for large tenant.
- [ ] Generate 100 groups.
- [ ] Generate 10k users/actors if feasible.
- [ ] Generate 100k posts.
- [ ] Generate 2M comments.
- [ ] Generate nested comments up to deep branches.

### 23.2 Query performance tests

- [ ] Measure home feed query.
- [ ] Measure group feed query.
- [ ] Measure post detail query.
- [ ] Measure root comment page query.
- [ ] Measure focused branch query.
- [ ] Measure search query.
- [ ] Add explain plans to performance notes.

### 23.3 Realtime load tests

- [ ] Simulate 1k WebSocket/SSE clients.
- [ ] Simulate hot post comment burst.
- [ ] Verify feed reorder events delivered.
- [ ] Verify server remains stable under reconnect storm.

### 23.4 Agent load tests

- [ ] Simulate agent event burst.
- [ ] Simulate failed webhook retry storm.
- [ ] Verify dead-letter behavior.
- [ ] Verify human API remains responsive.

Acceptance:

- [ ] Feed p95 is acceptable for target seed size.
- [ ] Hot post comments do not corrupt comment ordering.
- [ ] Agent failures do not block user comment creation.

---

## 24. Security hardening

### 24.1 Web security

- [ ] Add Content Security Policy.
- [ ] Add secure cookie settings.
- [ ] Add CSRF protection.
- [ ] Sanitize rendered content.
- [ ] Validate uploaded file size/type.
- [ ] Add rate limits for auth and content creation.
- [ ] Add abuse protection for mentions.

### 24.2 API security

- [ ] Require auth on all protected endpoints.
- [ ] Validate all route params.
- [ ] Validate all JSON bodies.
- [ ] Enforce idempotency on mutations that may be retried.
- [ ] Hide existence of private resources where appropriate.
- [ ] Add request size limits.

### 24.3 Agent security

- [ ] Sign outgoing agent webhooks.
- [ ] Validate incoming agent API tokens.
- [ ] Scope tokens to installation.
- [ ] Rate limit agent writes.
- [ ] Add admin kill switch for each agent.
- [ ] Ensure agent cannot fetch context outside scope.

### 24.4 Shared group security

- [ ] Add tests for cross-org data leaks.
- [ ] Add UI warnings for external groups.
- [ ] Confirm broad mentions in external groups.
- [ ] Audit external membership changes.

Acceptance:

- [ ] Basic security test suite passes.
- [ ] No known route returns private content to unauthorized actor.

---

## 25. Documentation

### 25.1 Developer docs

- [ ] Document local setup.
- [ ] Document environment variables.
- [ ] Document database migrations.
- [ ] Document test commands.
- [ ] Document architecture overview.
- [ ] Document permission model.

### 25.2 API docs

- [ ] Generate OpenAPI spec.
- [ ] Document auth.
- [ ] Document pagination.
- [ ] Document errors.
- [ ] Document posts endpoints.
- [ ] Document comments endpoints.
- [ ] Document agent endpoints.
- [ ] Document webhook signatures.

### 25.3 User/admin docs

- [ ] Explain posts vs groups.
- [ ] Explain comment/reply model.
- [ ] Explain feed bumping.
- [ ] Explain notifications.
- [ ] Explain installing agents.
- [ ] Explain shared groups.
- [ ] Explain Slack import limitations.

Acceptance:

- [ ] A new coding agent can implement a feature by reading docs and tests.
- [ ] A new admin can create groups, invite users, and install an agent.

---

## 26. Release checklist

### 26.1 MVP release gates

- [ ] Auth works.
- [ ] Groups work.
- [ ] Posts work.
- [ ] Nested comments work.
- [ ] Feed bumping works.
- [ ] Code blocks render correctly.
- [ ] Notifications work for mentions and replies.
- [ ] Basic agent mention/reply works.
- [ ] Search works with authorization filtering.
- [ ] Realtime updates work.
- [ ] Basic admin user/group management works.
- [ ] CI is green.
- [ ] Docker Compose local setup works.

### 26.2 Beta release gates

- [ ] Agent manifests and scopes work.
- [ ] Agent webhooks work.
- [ ] Assignments work.
- [ ] Shared groups work.
- [ ] Audit logs work.
- [ ] Attachment authorization works.
- [ ] Import/export works.
- [ ] Load tests pass target thresholds.
- [ ] Security review complete.

### 26.3 Slack migration release gates

- [ ] Slack OAuth works.
- [ ] Slack channel import works.
- [ ] Slack threads map to posts/comments.
- [ ] Rate limits handled.
- [ ] Import resume works.
- [ ] Import defaults to silent bump behavior.
- [ ] Slack notification bridge posts canonical links.
- [ ] Admin can see sync status and errors.

---

## 27. Definition of done for any feature

For each feature, require:

- [ ] Backend service implementation.
- [ ] API endpoint or job interface.
- [ ] Authorization checks.
- [ ] Input validation.
- [ ] Error handling.
- [ ] Unit tests.
- [ ] Integration tests for database behavior.
- [ ] Frontend UI if user-facing.
- [ ] Realtime update if applicable.
- [ ] Audit event if admin/security relevant.
- [ ] Documentation update.
- [ ] No lint/type errors.
- [ ] No skipped tests without written reason.

---

## 28. First vertical slice recommendation

Build this first before expanding horizontally:

1. Bootstrap one tenant and one user.
2. Create one group.
3. Create a post in that group.
4. Show group feed ordered by `activity_at`.
5. Open post detail.
6. Create root comment.
7. Create nested reply.
8. Update `posts.activity_at` on comment creation.
9. Watch feed reorder.
10. Add basic WebSocket/SSE event for `comment.created` and `post.bumped`.
11. Add one test agent actor that can be mentioned and reply.

This proves the core thesis: posts are the unit, comments are nested, activity revives old work, and agents participate in the same context model.
