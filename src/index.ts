import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { postRoutes } from './api/postRoutes.js';
import { DomainRepository } from './domain/repositories.js';
import { migrateUp, migrations, openDatabase } from './db/index.js';
import { healthRoute } from './health.js';
import { MembershipRepository } from './security/membership.js';

/**
 * Dependencies required to mount the C2 post feed API. Omit when building the
 * minimal health-only app used by the C0 smoke test.
 */
export interface AppDeps {
  repository: DomainRepository;
  membership: MembershipRepository;
}

/**
 * Build the Hono app. Pass deps to mount the C2 post feed API under /posts;
 * omit it for the minimal health-only app used by the C0 smoke test.
 */
export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();
  app.route('/health', healthRoute());
  if (deps) {
    app.route('/posts', postRoutes(deps));
  }
  app.get('/', (c) =>
    c.json({
      name: 'slack-that-theo-wants',
      status: 'ok',
      health: '/health',
      posts: deps ? '/posts' : undefined,
    }),
  );
  return app;
}

/**
 * Build the post-route dependencies for the dev server: open the SQLite
 * database at DATABASE_PATH (default `./app.db`), run migrations, and wire the
 * domain + membership repositories. Returns undefined when the database cannot
 * be opened so the health-only app still boots.
 */
function buildDeps(): AppDeps | undefined {
  try {
    const dbPath = process.env.DATABASE_PATH ?? './app.db';
    const db = openDatabase(dbPath);
    migrateUp(db, migrations);
    return {
      repository: new DomainRepository(db),
      membership: new MembershipRepository(db),
    };
  } catch (err) {
    console.error('post routes not mounted:', (err as Error).message);
    return undefined;
  }
}

const app = createApp(buildDeps());

const port = Number(process.env.PORT ?? 3000);
// Bind to loopback by default so the dev server is not exposed on every
// interface. Set HOST=0.0.0.0 explicitly to opt in to remote/container access.
const hostname = process.env.HOST ?? '127.0.0.1';

if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
    console.log(`Server listening on http://${host}:${info.port}`);
  });
}

export { app };
