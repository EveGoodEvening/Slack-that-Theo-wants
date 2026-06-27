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
  inside the same transaction as every comment/reply insert. C2 and C3 reuse
  it and must not invent competing bump logic.
- **Workspace boundary:** enforced at the data layer via composite FKs
  (`(workspace_id, author_actor_id)` → `actor(workspace_id, id)`) and a
  consistency trigger that rejects a comment whose workspace differs from its
  root post or whose parent belongs to a different workspace/root post.
- **Soft-delete:** `deleted_at` nullable timestamp on `post` and
  `comment_node`; hard delete is out of MVP scope. A trigger rejects replies
  into a soft-deleted subtree; repository reads return tombstones (redacted
  author/content, preserved structure and children).
