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
