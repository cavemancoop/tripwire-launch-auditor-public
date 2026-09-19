import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server';
import type { ApiEnv } from '../src/env';

const TOKEN = '0x00000000000000000000000000000000DeC0DeD1';
const KEY = 'partner-key-1';
const ENV: Partial<ApiEnv> = { designPartnerApiKeys: [KEY] };
const auth = { 'x-api-key': KEY };

describe('POST /v1/deepdive/:token', () => {
  // 2026-09-16: this endpoint spends the agent's own Orbio balance per call,
  // so once that balance held real money it needed the same key design
  // partners already send.
  it('refuses without a design-partner key — this spends real money', async () => {
    const enqueue = vi.fn();
    const app = buildServer({ enqueueDeepdive: enqueue as never, env: ENV as ApiEnv });
    const res = await app.inject({ method: 'POST', url: `/v1/deepdive/${TOKEN}` });
    expect(res.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a wrong key the same as no key', async () => {
    const app = buildServer({ enqueueDeepdive: vi.fn() as never, env: ENV as ApiEnv });
    const res = await app.inject({ method: 'POST', url: `/v1/deepdive/${TOKEN}`, headers: { 'x-api-key': 'wrong' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('enqueues an on-demand job and returns 202 for a valid key', async () => {
    const enqueue = vi.fn(async () => ({ id: 'job-1' }));
    const app = buildServer({ enqueueDeepdive: enqueue, env: ENV as ApiEnv });

    const res = await app.inject({ method: 'POST', url: `/v1/deepdive/${TOKEN}`, headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true, token: TOKEN.toLowerCase(), jobId: 'job-1', designPartner: true });
    expect(enqueue).toHaveBeenCalledWith({ tokenAddress: TOKEN.toLowerCase(), trigger: 'on_demand' });
    await app.close();
  });

  it('rejects a non-address token with 400 even with a valid key', async () => {
    const enqueue = vi.fn();
    const app = buildServer({ enqueueDeepdive: enqueue as never, env: ENV as ApiEnv });
    const res = await app.inject({ method: 'POST', url: '/v1/deepdive/not-a-token', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 when the queue is unavailable', async () => {
    const app = buildServer({
      enqueueDeepdive: async () => {
        throw new Error('redis down');
      },
      env: ENV as ApiEnv,
    });
    const res = await app.inject({ method: 'POST', url: `/v1/deepdive/${TOKEN}`, headers: auth });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
