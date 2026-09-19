import { describe, expect, it, vi } from 'vitest';
import {
  buildServer,
  decodeLaunchCursor,
  encodeLaunchCursor,
  type LaunchCursor,
  type LaunchFeedRow,
  type TokenReportRow,
} from '../src/server';

const TOKEN = '0x00000000000000000000000000000000DeC0DeD1';

describe('GET /v1/launches', () => {
  const ROW: LaunchFeedRow = {
    token: TOKEN.toLowerCase(),
    source: 'pons',
    lane: 'qualified',
    launchAt: '2026-09-12T00:00:00.000Z',
    launchBlock: '66000000',
    launchId: 'cmlaunch1',
    detV0: { pInsiderExit24h: 0.12, pDrawdown8024h: 0.34, pTradingAlive24h: 0.27, reportHash: '0xhash1' },
    proof: { committed: true, txHash: '0xtx1', committedAt: '2026-09-12T00:05:00.000Z' },
  };

  it('serves the feed from the injected reader; a short page has no next cursor', async () => {
    const reader = vi.fn(async () => [ROW]);
    const app = buildServer({ launchFeedReader: reader });
    const res = await app.inject({ method: 'GET', url: '/v1/launches' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 1, launches: [ROW], nextCursor: null });
    expect(reader).toHaveBeenCalledWith(50, undefined);
    await app.close();
  });

  it('clamps ?limit to [1, 200]', async () => {
    const reader = vi.fn(async () => []);
    const app = buildServer({ launchFeedReader: reader });
    await app.inject({ method: 'GET', url: '/v1/launches?limit=99999' });
    expect(reader).toHaveBeenCalledWith(200, undefined);
    await app.inject({ method: 'GET', url: '/v1/launches?limit=0' });
    expect(reader).toHaveBeenLastCalledWith(1, undefined);
    await app.close();
  });

  // 19 Sep audit: with only the newest 200 reachable, nobody could reconstruct the corpus.
  it('walks the whole corpus page by page, each launch exactly once, ties within a block included', async () => {
    const corpus: LaunchFeedRow[] = [];
    for (let b = 10; b >= 1; b--) {
      for (const suffix of ['c', 'b', 'a']) corpus.push({ ...ROW, launchBlock: String(b), launchId: `id${b}${suffix}`, token: `0x${b}${suffix}` });
    }
    // an in-memory reader with the same ordering and cursor semantics as the Prisma one
    const reader = async (limit: number, before?: LaunchCursor): Promise<LaunchFeedRow[]> =>
      corpus
        .filter((r) => !before || BigInt(r.launchBlock) < before.block || (BigInt(r.launchBlock) === before.block && r.launchId < before.id))
        .slice(0, limit);
    const app = buildServer({ launchFeedReader: reader });
    const seen: string[] = [];
    let url = '/v1/launches?limit=4';
    for (let i = 0; i < 20; i++) {
      const body = (await app.inject({ method: 'GET', url })).json();
      seen.push(...body.launches.map((l: LaunchFeedRow) => l.launchId));
      if (!body.nextCursor) break;
      url = `/v1/launches?limit=4&before=${body.nextCursor}`;
    }
    expect(seen).toEqual(corpus.map((r) => r.launchId));
    await app.close();
  });

  it('round-trips the cursor and 400s one it did not issue', async () => {
    expect(decodeLaunchCursor(encodeLaunchCursor({ block: 66_000_000n, id: 'cmabc' }))).toEqual({ block: 66_000_000n, id: 'cmabc' });
    const app = buildServer({ launchFeedReader: async () => [] });
    const res = await app.inject({ method: 'GET', url: `/v1/launches?before=${Buffer.from("1; drop table").toString('base64url')}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /v1/report/:token', () => {
  const ROW: TokenReportRow = {
    token: TOKEN.toLowerCase(),
    reportTime: '2026-09-12T00:00:00.000Z',
    forecasters: [
      {
        forecaster: 'det_v0',
        version: 'v0',
        trigger: 'launch',
        confidence: null,
        evidence: null,
        probabilities: { insiderExit24h: 0.12 },
        reportHash: '0xhash1',
        validatorPassed: true,
        proof: { committed: true, txHash: '0xtx1', committedAt: null },
      },
    ],
  };

  it('serves the injected report', async () => {
    const reader = vi.fn(async () => ROW);
    const app = buildServer({ reportReader: reader });
    const res = await app.inject({ method: 'GET', url: `/v1/report/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ROW);
    expect(reader).toHaveBeenCalledWith(TOKEN.toLowerCase());
    await app.close();
  });

  it('404s when nothing has been reported for the token', async () => {
    const app = buildServer({ reportReader: async () => null });
    const res = await app.inject({ method: 'GET', url: `/v1/report/${TOKEN}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400s a malformed token', async () => {
    const app = buildServer({ reportReader: async () => null });
    const res = await app.inject({ method: 'GET', url: '/v1/report/not-a-token' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/assess/:token', () => {
  it('enqueues and returns 202 with the roadmap note', async () => {
    const enqueue = vi.fn(async () => ({ id: 'assess-1' }));
    const app = buildServer({ enqueueAssess: enqueue });
    const res = await app.inject({ method: 'POST', url: `/v1/assess/${TOKEN}` });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ queued: true, token: TOKEN.toLowerCase(), jobId: 'assess-1', designPartner: false });
    expect(body.note).toMatch(/v0.3 Watch/);
    expect(enqueue).toHaveBeenCalledWith({ tokenAddress: TOKEN.toLowerCase() });
    await app.close();
  });

  it('reports designPartner:true for a recognized x-api-key', async () => {
    const app = buildServer({
      enqueueAssess: async () => ({ id: 'a' }),
      env: {
        rpcUrl: '',
        chainId: 4663,
        designPartnerApiKeys: ['secret-key'],
        benchmarkFile: 'data/benchmark.json',
        priceDeepdiveUsdg: 0.1,
        deepdiveDailyCapUsd: 5,
        deepdiveCapPerRunUsd: 0.2,
        metabolismReserveUsd: 3,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/assess/${TOKEN}`,
      headers: { 'x-api-key': 'secret-key' },
    });
    expect(res.json().designPartner).toBe(true);
    await app.close();
  });

  it('400s a malformed token, never touching the queue', async () => {
    const enqueue = vi.fn();
    const app = buildServer({ enqueueAssess: enqueue as never });
    const res = await app.inject({ method: 'POST', url: '/v1/assess/not-a-token' });
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });
});
