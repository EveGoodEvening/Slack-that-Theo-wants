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
- `npm run dev` starts the server; `GET /health` responds with `status: "ok"`.
- `npm run build`, `npm run lint`, `npm run typecheck` each exit clean.
