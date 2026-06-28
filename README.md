# Slack that Theo wants

Idea from Theo (https://x.com/theo/status/2069621429189161350 / https://www.youtube.com/watch?v=wEAb0x3wTRc). Note that Theo has no endorsement on this project (yet).

## Rationale - Slack alternative

Slack has extremely strong user lock-in—its connection system (cross-company shared channels) is very powerful, and almost all of Theo’s Slack channels exist to communicate with other companies. But Slack itself is terrible:

-  No inline replies; you have to create a thread
-  Threads sink into history and are hard to find even when active
-  You can’t reply to individual messages inside a thread
-  Poor code block experience

And worse: agents are completely awkward in Slack. Slack is designed for sending messages, and that’s it. It’s not designed for reading messages, determining work priorities, or getting status updates.

**What Theo wants (inspired by Facebook Workplace)**
-  Posts as the basic unit, sitting somewhere between channels and topics, a more sensible abstraction than Slack’s message/thread model
-  First-level comments and nested replies under each post
-  The ability to reply to different people in comments without clogging the main post
-  Old posts with new comments get bumped back to the top of the feed (this is the most important feature)
-  Unlimited nesting and logically organized discussion threads
-  Agents can enter in a logical way and become part of the same control plane

Facebook Workplace is the best context-management tool Theo has ever seen. The post → comment → subcomment nesting structure works well for both humans and agents. But Meta has shut it down.

Theo even started building this himself, but he was too busy to finish it. Theo wants something like Slack, but that feels more like Facebook, and is easy to interact with through agents. Imagine combining it with Hermes Agent—you post what you want to do in a group, and when the agent replies to the post, it gets bumped back to the top. Theo hopes this becomes an open-source standard, not to replace Slack outright, but to gradually replace it.


## Stack

TypeScript (strict) on Node.js 20+, with Hono as the web framework, Vitest as the test runner, and Biome for formatting + linting. Local persistence will be SQLite (`better-sqlite3`), introduced in the persistence chunk. See [`docs/stack-decision.md`](docs/stack-decision.md) for the full rationale.

## Development

Requires Node.js 20.11+ and npm.

```bash
npm install        # install dependencies for a fresh checkout
npm run dev        # start the local server (http://127.0.0.1:3000)
npm test           # run the full Vitest suite once
npm run build      # compile TypeScript to dist/
npm run lint       # lint with Biome
npm run typecheck  # typecheck with tsc --noEmit
```

The dev server opens SQLite at `./app.sqlite` by default, applies all pending
migrations on startup, and binds to loopback (`127.0.0.1`) so it is not exposed
on every network interface. Override the database path or host only when needed:

```bash
DATABASE_PATH=./local.sqlite npm run dev
HOST=0.0.0.0 npm run dev
```

Health check: `GET http://127.0.0.1:3000/health` returns `{ "status": "ok", ... }`.
The app does not ship demo users or a seed CLI yet; local experiments should
create workspaces, actors, auth identities, and agent credentials through the
repository/security helpers used by the tests, then sign in through `/auth/signin`.

## Human usage and API

Browser UI:

- `GET /auth/signin` renders the local sign-in form. `POST /auth/signin` accepts
  `email`, `password`, and optional `workspaceId`, then sets the HttpOnly
  `sttw_session` cookie and redirects to `/feed`.
- `GET /feed` renders the activity-ordered post feed. `POST /feed` creates a
  post in the signed-in workspace. `POST /feed/preview` renders composer text
  through the same safe renderer used for stored posts/comments.
- `GET /feed/:postId` renders the post detail conversation. `POST
  /feed/:postId/comments` creates a first-level comment, and `POST
  /feed/:postId/comments/:commentId/replies` creates a nested reply.
- `GET /events` is the server-sent events stream used by the progressively
  enhanced feed/detail pages. It is a hint stream; durable state is always read
  back through the feed or conversation routes.

JSON API for human/session callers (cookie or `Authorization: Bearer <session>`):

- `POST /posts` with `{ "content": "..." }` creates a post.
- `GET /posts?limit=20&cursor=<nextCursor>` lists the feed ordered by
  `lastActivityAt DESC, postId DESC` and returns `{ posts, nextCursor }`.
- `GET /posts/:id` returns one post plus live comment counts.
- `POST /posts/:postId/comments` and `POST /comments/:parentId/replies` create
  comments/replies with `{ "content": "..." }`.
- `GET /posts/:postId/thread` returns the full comment tree; `GET
  /comments/:id/subtree` returns one subtree.

Agent API (`Authorization: Bearer <agent-secret>`):

- Writes require `x-idempotency-key` and reuse the same post/comment services as
  humans: `POST /agents/posts`, `POST /agents/posts/:postId/comments`, and
  `POST /agents/comments/:parentId/replies`.
- Read surfaces are least-privilege and workspace-scoped: `GET /agents/feed`,
  `GET /agents/status`, `GET /agents/status/:postId`, `GET
  /agents/posts/:postId`, `GET /agents/posts/:postId/thread`, `GET
  /agents/comments/:id/subtree`, and `GET /agents/audit`.
- Credential lifecycle endpoints are `POST /agents/credentials`, `POST
  /agents/credentials/rotate`, and `POST /agents/credentials/revoke`. Plaintext
  agent secrets are returned only once at issuance/rotation.

## Project status

This repo follows a dependency-ordered implementation plan. See
[`docs/implementation-plan.md`](docs/implementation-plan.md) for the stable
chunk breakdown and [`docs/progress.md`](docs/progress.md) for live status.
C10 hardening work is implemented in the C10 worktree and verified by the
orchestrator; the tracker marks C10 done.
