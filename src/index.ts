import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { healthRoute } from './health.js';

export function createApp(): Hono {
  const app = new Hono();
  app.route('/health', healthRoute());
  app.get('/', (c) =>
    c.json({
      name: 'slack-that-theo-wants',
      status: 'ok',
      health: '/health',
    }),
  );
  return app;
}

const app = createApp();

const port = Number(process.env.PORT ?? 3000);

if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Server listening on http://localhost:${info.port}`);
  });
}

export { app };
