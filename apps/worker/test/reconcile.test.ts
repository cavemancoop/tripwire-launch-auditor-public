import { describe, expect, it } from 'vitest';
import { deepdiveRunGate } from '../src/metabolism/budget';
import { billingBlocksInference, reconcileEpoch, type EpochInput } from '../src/metabolism/reconcile';

const epoch = (over: Partial<EpochInput> = {}): EpochInput => ({
  providerSpendNowUsd: 10.43,
  providerSpendPrevUsd: 10,
  localEstimateUsd: 0.412,
  requestCount: 37,
  anomalyPct: 50,
  phantomToleranceUsd: 0.005,
  ...over,
});

describe('reconcileEpoch — provider delta vs local estimates (M5c)', () => {
  it('grades the estimator: factor and signed discrepancy', () => {
    const r = reconcileEpoch(epoch());
    expect(r.providerDeltaUsd).toBeCloseTo(0.43, 6);
    expect(r.localEstimateUsd).toBeCloseTo(0.412, 6);
    expect(r.reconciliationFactor).toBeCloseTo(0.43 / 0.412, 4);
    expect(r.discrepancyPct).toBeCloseTo(4.37, 1);
    expect(r.anomaly).toBe(false);
    expect(r.phantom).toBe(false);
    expect(r.billingStatus).toBe('aggregate_only');
  });

  it('a ledger/provider gap is an ANOMALY that pauses — never a revoke', () => {
    // estimator says $0.10, provider charged $0.40: +300%
    const r = reconcileEpoch(epoch({ providerSpendNowUsd: 10.4, localEstimateUsd: 0.1, requestCount: 3 }));
    expect(r.anomaly).toBe(true);
    expect(r.phantom).toBe(false);
    expect(r.billingStatus).toBe('anomaly');
    expect(r.reason).toMatch(/estimator anomaly/);
  });

  it('PHANTOM: provider spend rose with zero local requests', () => {
    const r = reconcileEpoch(epoch({ providerSpendNowUsd: 10.02, localEstimateUsd: 0, requestCount: 0 }));
    expect(r.phantom).toBe(true);
    expect(r.billingStatus).toBe('phantom');
    expect(r.reason).toMatch(/phantom spend/);
  });

  it('a sub-tolerance drift with zero requests is rounding noise, not phantom', () => {
    const r = reconcileEpoch(epoch({ providerSpendNowUsd: 10.004, localEstimateUsd: 0, requestCount: 0 }));
    expect(r.phantom).toBe(false);
    expect(r.billingStatus).toBe('aggregate_only');
    expect(r.reason).toMatch(/idle/);
  });

  it('requests ran but nothing could be priced → unavailable, not anomaly, not 0', () => {
    const r = reconcileEpoch(epoch({ localEstimateUsd: 0, requestCount: 5 }));
    expect(r.billingStatus).toBe('unavailable');
    expect(r.reconciliationFactor).toBeNull();
    expect(r.discrepancyPct).toBeNull();
    expect(r.anomaly).toBe(false);
    expect(r.providerDeltaUsd).toBeCloseTo(0.43, 6);
  });

  it('provider reporting less than the estimate is a negative discrepancy, still reconciled', () => {
    const r = reconcileEpoch(epoch({ providerSpendNowUsd: 10.3, localEstimateUsd: 0.412 }));
    expect(r.discrepancyPct).toBeLessThan(0);
    expect(r.anomaly).toBe(false);
    expect(r.reconciliationFactor).toBeCloseTo(0.3 / 0.412, 4);
  });

  it('a provider counter that went backwards clamps the delta to zero', () => {
    const r = reconcileEpoch(epoch({ providerSpendNowUsd: 9.9, requestCount: 2, localEstimateUsd: 0.02 }));
    expect(r.providerDeltaUsd).toBe(0);
    expect(r.reconciliationFactor).toBeNull();
    expect(r.phantom).toBe(false);
  });
});

describe('reconcileEpoch — late-landing charges (2026-09-16)', () => {
  const tiny = { anomalyPct: 50, phantomToleranceUsd: 0.005 };

  it('spend in an idle window right after a busy one is lag, not phantom', () => {
    const r = reconcileEpoch({ providerSpendNowUsd: 1.03, providerSpendPrevUsd: 1.0, localEstimateUsd: 0, requestCount: 0, lagRequestCount: 12, ...tiny });
    expect(r.phantom).toBe(false);
    expect(r.billingStatus).toBe('aggregate_only');
  });

  it('spend with no requests in this OR the previous window is still phantom', () => {
    const r = reconcileEpoch({ providerSpendNowUsd: 1.03, providerSpendPrevUsd: 1.0, localEstimateUsd: 0, requestCount: 0, lagRequestCount: 0, ...tiny });
    expect(r.phantom).toBe(true);
  });

  it('a sub-cent window is too small to grade — the live -100% case', () => {
    const r = reconcileEpoch({ providerSpendNowUsd: 0, providerSpendPrevUsd: 0, localEstimateUsd: 0.0023, requestCount: 5, ...tiny });
    expect(r.anomaly).toBe(false);
    expect(r.reason).toMatch(/too small to grade/);
  });

  it('a window above the grading floor is still graded', () => {
    const r = reconcileEpoch({ providerSpendNowUsd: 0, providerSpendPrevUsd: 0, localEstimateUsd: 0.5, requestCount: 40, ...tiny });
    expect(r.anomaly).toBe(true);
  });
});

describe('billingBlocksInference', () => {
  it('blocks on anomaly and phantom only', () => {
    expect(billingBlocksInference('anomaly')).toBe(true);
    expect(billingBlocksInference('phantom')).toBe(true);
    expect(billingBlocksInference('aggregate_only')).toBe(false);
    expect(billingBlocksInference('unavailable')).toBe(false);
    expect(billingBlocksInference('exact')).toBe(false);
    expect(billingBlocksInference(null)).toBe(false);
  });
});

describe('deepdiveRunGate — M5c billing controls', () => {
  const IN = { capPerRunUsd: 0.2, dailyCapUsd: 5, todaySpendUsd: 0, spendableUsd: 40 };

  it('an anomaly or phantom billing state closes the gate without touching the key', () => {
    for (const billingStatus of ['anomaly', 'phantom'] as const) {
      const g = deepdiveRunGate({ ...IN, billingStatus });
      expect(g.allowed).toBe(false);
      expect(g.maxRunCostUsd).toBe(0);
      expect(g.reason).toMatch(/paused/);
    }
  });

  it('aggregate_only / unavailable / null leave the gate open', () => {
    for (const billingStatus of ['aggregate_only', 'unavailable', null] as const) {
      expect(deepdiveRunGate({ ...IN, billingStatus }).allowed).toBe(true);
    }
  });

  // A lapsed Orbio session is not a compromise signal. Measured 2026-09-14: a
  // gateway key still bills inference with a two-day-dead OAuth session, so the
  // session bounds key management, not spending. Blocking on it meant
  // llm_deepdive_v0 never ran in production at all.
  it('stale billing keeps the gate open but flags the balance as unconfirmed', () => {
    const g = deepdiveRunGate({ ...IN, billingStatus: 'stale' });
    expect(g.allowed).toBe(true);
    expect(g.balanceStale).toBe(true);
    expect(g.maxRunCostUsd).toBeGreaterThan(0);
    expect(g.reason).toMatch(/stale/);
  });

  it('a stale balance is still bounded by the daily cap and the local ledger', () => {
    const g = deepdiveRunGate({ ...IN, billingStatus: 'stale', todaySpendUsd: 5 });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/daily cap/);
    expect(g.balanceStale).toBe(true);
  });

  it('phantom still closes the gate even when the balance is also stale', () => {
    expect(deepdiveRunGate({ ...IN, billingStatus: 'phantom' }).allowed).toBe(false);
  });

  it('the daily cap is enforced against the LARGER of local estimate and provider spend', () => {
    // local ledger thinks $1 spent, the provider says $5 — the provider wins
    const g = deepdiveRunGate({ ...IN, todaySpendUsd: 1, providerSpendTodayUsd: 5 });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/daily cap/);
    expect(g.reason).toMatch(/\$5/);
    // and the reverse: a stale provider figure does not hide local spend
    expect(deepdiveRunGate({ ...IN, todaySpendUsd: 5, providerSpendTodayUsd: 0.5 }).allowed).toBe(false);
  });
});
