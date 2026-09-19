import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';

describe('api', () => {
  it('GET /health returns ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'launch-auditor-api' });
    await app.close();
  });

  // M8 — the dashboard (apps/web) is served from its own port; every read
  // endpoint here is public, so CORS is deliberately wide open.
  it('sends permissive CORS headers on a normal request', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    await app.close();
  });

  it('answers an OPTIONS preflight with 204 and no body', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'OPTIONS', url: '/v1/launches' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await app.close();
  });
});
