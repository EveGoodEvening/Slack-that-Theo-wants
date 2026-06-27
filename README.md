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
npm install        # install dependencies (fresh checkout)
npm run dev        # start the dev server with live reload (http://127.0.0.1:3000)
npm test           # run the test suite once
npm run build      # compile TypeScript to dist/
npm run lint       # lint with Biome
npm run typecheck  # typecheck with tsc --noEmit
```

The dev server binds to loopback (`127.0.0.1`) by default so it is not exposed
on every network interface. To allow connections from other hosts (for example
remote or container dev), opt in explicitly:

```bash
HOST=0.0.0.0 npm run dev
```

Health check: `GET http://127.0.0.1:3000/health` returns `{ "status": "ok", ... }`.

## Project status

This repo follows a dependency-ordered implementation plan. See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the chunk breakdown and [`docs/progress.md`](docs/progress.md) for current status. Only the C0 scaffold (stack, scripts, health route, smoke test) exists today; product features land in later chunks.
