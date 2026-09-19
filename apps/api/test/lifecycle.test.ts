import { describe, expect, it, vi } from 'vitest';
import { GENESIS_HASH, lifecycleBodyHash } from '@launch-auditor/db';
import { buildServer, type EstimatorSummary, type LifecycleApiRow } from '../src/server';
import type { ApiEnv } from '../src/env';

const ZERO_SPEND = async () => ({ ledgerUsd: 0, providerUsd: 0 });

const BASE_ENV: ApiEnv = {
  rpcUrl: '',
  chainId: 4663,
  designPartnerApiKeys: [],
  benchmarkFile: '/dev/null/unused.json',
  priceDeepdiveUsdg: 0.1,
  deepdiveDailyCapUsd: 5,
  deepdiveCapPerRunUsd: 0.2,
  metabolismReserveUsd: 3,
};

// every test below stubs this — the default hits Prisma, and these tests are
// about the hash chain / limit clamping, not the M5c estimator block.
const EMPTY_ESTIMATOR: EstimatorSummary = {
  windows: 0,
  providerSpend24hUsd: 0,
  estimatedSpend24hUsd: 0,
  requests24h: 0,
  meanAbsDiscrepancyPct: null,
  latest: null,
  basis: 'none',
};

/** Build a valid hash-chained run of `n` rows, oldest → newest. */
function chain(n: number): LifecycleApiRow[] {
  const rows: LifecycleApiRow[] = [];
  let prevHash: string = GENESIS_HASH;
  for (let i = 0; i < n; i += 1) {
    const body = {
      at: new Date(1_760_000_000_000 + i * 60_000).toISOString(),
      prevState: (i === 0 ? null : 'NO_KEY') as string | null,
      newState: 'NO_KEY',
      reason: i === 0 ? 'instance start' : `snapshot ${i}`,
      isSnapshot: i !== 0,
      keyHashPrefix: null,
      balanceUsd: 24.01,
      keyRemainingUsd: null,
      reserveUsd: 3,
      ledgerSpendUsd: 0,
      providerSpendUsd: 0,
      idsMismatch: false,
      prevHash: prevHash as `0x${string}`,
    };
    const bodyHash = lifecycleBodyHash(body);
    rows.push({ id: `row-${i}`, signature: `0xsig${i}`, keyId: null, ...body, bodyHash });
    prevHash = bodyHash;
  }
  return rows;
}

describe('GET /v1/lifecycle', () => {
  it('serves the signed chain and verifies it', async () => {
    const rows = chain(3);
    const reader = vi.fn(async () => rows);
    const app = buildServer({ todaySpendReader: ZERO_SPEND, lifecycleReader: reader, estimatorReader: async () => EMPTY_ESTIMATOR });

    const res = await app.inject({ method: 'GET', url: '/v1/lifecycle' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(3);
    expect(body.verified).toBe(true);
    expect(body.startsAtGenesis).toBe(true);
    expect(body.brokenAt).toBeNull();
    expect(body.genesisHash).toBe(GENESIS_HASH);
    expect(body.entries).toHaveLength(3);
    expect(body.entries[0].bodyHash).toBe(rows[0]!.bodyHash);
    expect(reader).toHaveBeenCalledWith(200);
    await app.close();
  });

  it('reports verified:false when a served row is tampered', async () => {
    const rows = chain(3);
    rows[1] = { ...rows[1]!, reason: 'tampered after signing' };
    const app = buildServer({ todaySpendReader: ZERO_SPEND, lifecycleReader: async () => rows, estimatorReader: async () => EMPTY_ESTIMATOR });

    const body = (await app.inject({ method: 'GET', url: '/v1/lifecycle' })).json();
    expect(body.verified).toBe(false);
    expect(body.brokenAt).toBe(1);
    await app.close();
  });

  it('clamps ?limit and passes it to the reader', async () => {
    const reader = vi.fn(async () => chain(1));
    const app = buildServer({ todaySpendReader: ZERO_SPEND, lifecycleReader: reader, estimatorReader: async () => EMPTY_ESTIMATOR });

    await app.inject({ method: 'GET', url: '/v1/lifecycle?limit=99999' });
    expect(reader).toHaveBeenCalledWith(1000);

    await app.inject({ method: 'GET', url: '/v1/lifecycle?limit=1' });
    expect(reader).toHaveBeenLastCalledWith(1);
    await app.close();
  });

  it('empty log verifies vacuously', async () => {
    const app = buildServer({ todaySpendReader: ZERO_SPEND, lifecycleReader: async () => [], estimatorReader: async () => EMPTY_ESTIMATOR });
    const body = (await app.inject({ method: 'GET', url: '/v1/lifecycle' })).json();
    expect(body).toMatchObject({ count: 0, verified: true, startsAtGenesis: true });
    await app.close();
  });

  // M5c: the metabolism's own cost-forecast error, graded like any other
  // forecaster, rides along on the same endpoint.
  it('carries the M5c estimator summary', async () => {
    const estimator: EstimatorSummary = {
      windows: 12,
      providerSpend24hUsd: 0.43,
      estimatedSpend24hUsd: 0.41,
      requests24h: 37,
      meanAbsDiscrepancyPct: 4.4,
      latest: { at: '2026-09-12T04:00:00.000Z', billingStatus: 'aggregate_only', discrepancyPct: 4.4, reconciliationFactor: 1.04 },
      basis: 'epoch_reconciled',
    };
    const app = buildServer({ todaySpendReader: ZERO_SPEND, lifecycleReader: async () => [], estimatorReader: async () => estimator });
    const body = (await app.inject({ method: 'GET', url: '/v1/lifecycle' })).json();
    expect(body.estimator).toEqual(estimator);
    await app.close();
  });

  // M8 — the dashboard's Metabolism panel reads this to show "today's budget
  // as a function of trailing-24h accrual" without re-deriving the worker's
  // gate formula itself.
  it('carries a budget block computed by the worker gate over the UTC day', async () => {
    const rows = chain(1);
    rows[0] = { ...rows[0]!, balanceUsd: 4, billingStatus: 'exact' };
    const estimator: EstimatorSummary = {
      windows: 3,
      providerSpend24hUsd: 1.2,
      estimatedSpend24hUsd: 1.1,
      requests24h: 9,
      meanAbsDiscrepancyPct: 8.3,
      latest: { at: '2026-09-12T04:00:00.000Z', billingStatus: 'exact', discrepancyPct: 8.3, reconciliationFactor: 1.08 },
      basis: 'epoch_reconciled',
    };
    const app = buildServer({
      todaySpendReader: async () => ({ ledgerUsd: 1.1, providerUsd: 1.2 }),
      lifecycleReader: async () => rows,
      estimatorReader: async () => estimator,
      env: BASE_ENV,
    });
    const body = (await app.inject({ method: 'GET', url: '/v1/lifecycle' })).json();
    expect(body.budget).toMatchObject({
      dailyCapUsd: 5,
      effectiveDailyCapUsd: 5,
      capSource: 'flat_fallback', // no CREDIT source configured in this env
      capPerRunUsd: 0.2,
      spentTodayUsd: 1.2, // the larger of ledger and provider, like the worker
      spendWindow: 'utc_day',
      remainingTodayUsd: 3.8,
      spendableUsd: 1,
      maxRunCostUsd: 0.2,
      allowed: true,
      gateClosedByBilling: false,
      balanceStale: false,
      balanceUnknown: false,
    });
    await app.close();
  });

  it('closes the budget gate when billing status is anomaly or phantom', async () => {
    const rows = chain(1);
    rows[0] = { ...rows[0]!, balanceUsd: 4, billingStatus: "phantom" };
    const app = buildServer({ todaySpendReader: ZERO_SPEND,
      lifecycleReader: async () => rows,
      estimatorReader: async () => EMPTY_ESTIMATOR,
      env: BASE_ENV,
    });
    const body = (await app.inject({ method: 'GET', url: '/v1/lifecycle' })).json();
    expect(body.budget.gateClosedByBilling).toBe(true);
    expect(body.budget.maxRunCostUsd).toBe(0);
    await app.close();
  });
});
