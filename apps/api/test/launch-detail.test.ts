import { describe, expect, it, vi } from 'vitest';
import { buildServer, type LaunchDetailRow } from '../src/server';

const TOKEN = '0x00000000000000000000000000000000DeC0DeD1';

describe('GET /v1/launch/:token', () => {
  const ROW: LaunchDetailRow = {
    token: TOKEN.toLowerCase(),
    chainId: 4663,
    source: 'pons',
    sourceConfidence: 0.9,
    creatorAddress: '0xcreator',
    launchBlock: '55362197',
    launchTxHash: '0xtx',
    launchAt: '2026-09-12T00:00:00.000Z',
    detectedVia: 'v4:Initialize',
    lane: 'qualified',
    quotaExceeded: false,
    retrospective: false,
    primaryPool: {
      lpLockedByConstruction: true,
      quoteAddress: '0xquote',
      poolKind: 'v4',
      poolAddress: null,
      poolId: '0xpoolid',
      poolFee: 3000,
      poolTickSpacing: 60,
      poolHooks: '0x0',
      poolFeeSuspect: false,
      primaryPoolCheckedAt: '2026-09-12T00:10:00.000Z',
      tokenAgeAtPoolSec: 12,
    },
    feature: { creatorDevbuyPct: 0.04, provenance: { creatorDevbuyPct: { source: 'rpc', block: 1, fetchedAt: 't' } } },
    outcomes: [
      {
        label: 'DRAWDOWN_80',
        horizon: '24h',
        status: 'RESOLVED',
        value: true,
        trigger: 'launch',
        anchorTime: '2026-09-12T00:00:00.000Z',
        ruleVersion: 'v1',
        evidence: { blockNumber: 1 },
        coverage: { blocksScanned: 100 },
        retrospective: false,
        measuredAt: '2026-09-13T00:00:00.000Z',
      },
    ],
  };

  it('serves the injected detail', async () => {
    const reader = vi.fn(async () => ROW);
    const app = buildServer({ launchDetailReader: reader });
    const res = await app.inject({ method: 'GET', url: `/v1/launch/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ROW);
    expect(reader).toHaveBeenCalledWith(TOKEN.toLowerCase());
    await app.close();
  });

  it('404s when the token has no launch row', async () => {
    const app = buildServer({ launchDetailReader: async () => null });
    const res = await app.inject({ method: 'GET', url: `/v1/launch/${TOKEN}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400s a malformed token', async () => {
    const app = buildServer({ launchDetailReader: async () => null });
    const res = await app.inject({ method: 'GET', url: '/v1/launch/not-a-token' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('serves feature: null when the launch has no feature row yet', async () => {
    const app = buildServer({ launchDetailReader: async () => ({ ...ROW, feature: null, outcomes: [] }) });
    const res = await app.inject({ method: 'GET', url: `/v1/launch/${TOKEN}` });
    expect(res.json().feature).toBeNull();
    expect(res.json().outcomes).toEqual([]);
    await app.close();
  });
});
