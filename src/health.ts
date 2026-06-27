import { Hono } from 'hono';

/**
 * Minimal health surface for C0 scaffold.
 *
 * Returns process uptime and a fixed ok status so a smoke test can assert real
 * behavior without depending on any product feature. Later chunks extend this
 * with dependency checks (database, realtime) — do not add those here.
 */
export function healthRoute(): Hono {
  const route = new Hono();

  route.get('/', (c) => {
    const uptimeSeconds = process.uptime();
    return c.json({
      status: 'ok',
      uptimeSeconds,
      timestamp: new Date().toISOString(),
    });
  });

  return route;
}
