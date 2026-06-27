import { describe, expect, it } from 'vitest';
import { createApp } from './index.js';

describe('health route (C0 smoke)', () => {
  const app = createApp();

  it('responds 200 with status ok and numeric uptime on /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = (await res.json()) as {
      status: string;
      uptimeSeconds: number;
      timestamp: string;
    };

    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(body.uptimeSeconds)).toBe(true);
    // ISO 8601 timestamp parses back to a Date.
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('responds 200 on root with a health pointer', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { health: string };
    expect(body.health).toBe('/health');
  });

  it('returns 404 for an unknown path', async () => {
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
