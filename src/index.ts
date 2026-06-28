import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ActivityEventHub, type ActivityEventSource } from './api/activityEvents.js';
import { authRoutes } from './api/authRoutes.js';
import { activityRoutes } from './api/activityRoutes.js';
import { agentRoutes } from './api/agentRoutes.js';
import { CommentServiceImpl } from './api/commentService.js';
import { commentRoutes } from './api/commentRoutes.js';
import { PostServiceImpl } from './api/postService.js';
import { postRoutes } from './api/postRoutes.js';
import { feedRoutes } from './ui/feed.js';
import { postDetailRoutes } from './ui/postDetail.js';
import { DomainRepository } from './domain/repositories.js';
import { migrateUp, migrations, openDatabase } from './db/index.js';
import { healthRoute } from './health.js';
import { MembershipRepository } from './security/membership.js';
import { AuthRepository } from './security/auth.js';

/**
 * Dependencies required to mount the C2 post feed API and later surfaces. Omit
 * when building the minimal health-only app used by the C0 smoke test.
 */
export interface AppDeps {
  repository: DomainRepository;
  membership: MembershipRepository;
  auth: AuthRepository;
  /** The underlying database connection, used when mounting C7 agent routes. */
  db?: import('./db/connection.js').BetterSqliteDatabase;
  /** Shared in-process C8 event source; tests may inject one. */
  activity?: ActivityEventSource;
}

/**
 * Build the Hono app. Pass deps to mount the C2 post feed API under /posts;
 * omit it for the minimal health-only app used by the C0 smoke test.
 */
export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();
  app.route('/health', healthRoute());
  if (deps) {
    const activity = deps.activity ?? new ActivityEventHub();
    const postService = new PostServiceImpl(deps.repository, activity);
    const commentService = new CommentServiceImpl(deps.repository, activity);

    app.route('/auth', authRoutes({ auth: deps.auth }));
    app.route(
      '/events',
      activityRoutes({ auth: deps.auth, membership: deps.membership, events: activity }),
    );
    app.route('/posts', postRoutes({ ...deps, service: postService }));
    // C3 comment/reply surface. Mounted at root because it spans /posts/.../comments
    // and /comments/.../replies prefixes; the route file owns the full paths.
    app.route('/', commentRoutes({ ...deps, service: commentService }));
    // C4/C5 minimal human UI: feed + post detail conversation view consuming
    // the C2 post service, C3 comment service, and C3a safe renderer.
    app.route(
      '/feed',
      feedRoutes({ auth: deps.auth, membership: deps.membership, service: postService }),
    );
    app.route(
      '/feed',
      postDetailRoutes({
        membership: deps.membership,
        auth: deps.auth,
        postService,
        commentService,
      }),
    );
    // C7 agent control-plane API: agents create posts/comments/replies and read
    // machine-readable feed/status metadata through the same C2/C3 services and
    // C1a authorization boundaries, with scoped credentials, idempotency, audit
    // logging, and rate limits layered on top. Mounted under /agents when the
    // caller supplies the underlying database-backed security stores.
    if (deps.db !== undefined) {
      app.route(
        '/agents',
        agentRoutes({
          ...deps,
          db: deps.db,
          activity,
          postService,
          commentService,
        }),
      );
    }
  }
  app.get('/', (c) =>
    c.json({
      name: 'slack-that-theo-wants',
      status: 'ok',
      health: '/health',
      posts: deps ? '/posts' : undefined,
      comments: deps ? '/comments' : undefined,
      feed: deps ? '/feed' : undefined,
      auth: deps ? '/auth/signin' : undefined,
      events: deps ? '/events' : undefined,
      agents: deps?.db !== undefined ? '/agents' : undefined,
    }),
  );
  return app;
}

function buildDeps(): AppDeps | undefined {
  try {
    const dbPath = process.env.DATABASE_PATH ?? './app.sqlite';
    const db = openDatabase(dbPath);
    migrateUp(db, migrations);
    return {
      repository: new DomainRepository(db),
      membership: new MembershipRepository(db),
      auth: new AuthRepository(db),
      db,
    };
  } catch (err) {
    console.error('post routes not mounted:', (err as Error).message);
    return undefined;
  }
}

export const app = createApp();

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  // Bind to loopback by default so the dev server is not exposed on every
  // interface. Set HOST=0.0.0.0 explicitly to opt in to remote/container access.
  const hostname = process.env.HOST ?? '127.0.0.1';
  const serverApp = createApp(buildDeps());
  serve({ fetch: serverApp.fetch, port, hostname }, (info) => {
    const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
    console.log(`Server listening on http://${host}:${info.port}`);
  });
}
