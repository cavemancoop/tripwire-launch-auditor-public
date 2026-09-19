import { describe, expect, it } from 'vitest';
import {
  ALL_OUTCOME_KEYS,
  DET_V0_WEIGHTS,
  type FeatureInputs,
  detV0,
  heuristicV1,
} from '../src/index';

const base = (o: Partial<FeatureInputs> = {}): FeatureInputs => ({
  source: 'raw',
  lpLockedByConstruction: false,
  creatorDevbuyPct: null,
  creatorAgeDays: null,
  creatorPriorLaunches: null,
  creatorPriorInsiderExitRate: null,
  clusterSize: null,
  launchBlockClusterSize: null,
  clusterSupplyPct: null,
  top10NoncreatorPct: null,
  uniqueBuyers10m: null,
  buysPerBuyer10m: null,
  microbuyShare10m: null,
  liquidityUsd10m: null,
  sellImpactBps: null,
  hasX: null,
  hasSite: null,
  verified: null,
  ownerRenounced: null,
  mintable: null,
  sellSimOk: null,
  sellTaxBps: null,
  hookCanBlockSwap: null,
  hookCanTaxSwap: null,
  hookGatesLpRemoval: null,
  sidePoolCount: null,
  creatorApprovalsOutsideRouters: null,
  ...o,
});

describe('heuristic_v1 (spec §2)', () => {
  it('does not fire on empty inputs', () => {
    const r = heuristicV1(base());
    expect(r.fired).toBe(false);
    // risk cells 0.12; TRADING_ALIVE (positive) inverted to 0.88
    for (const [k, p] of Object.entries(r.probabilities)) {
      expect(p).toBe(k.startsWith('TRADING_ALIVE') ? 0.88 : 0.12);
    }
    expect(Object.keys(r.probabilities)).toHaveLength(11);
  });

  it('fires on any one of the three conditions', () => {
    expect(heuristicV1(base({ creatorDevbuyPct: 5 })).reasons[0]).toMatch(/devbuy/);
    expect(heuristicV1(base({ launchBlockClusterSize: 3 })).reasons[0]).toMatch(/cluster/);
    expect(heuristicV1(base({ top10NoncreatorPct: 40 })).reasons[0]).toMatch(/top10/);
  });

  it('does not fire just below the thresholds', () => {
    expect(heuristicV1(base({ creatorDevbuyPct: 4.9, launchBlockClusterSize: 2, top10NoncreatorPct: 39.9 })).fired).toBe(false);
  });

  it('omits SELL_IMPAIRED / LIQ_IMPAIRED for launchpad-locked tokens', () => {
    const r = heuristicV1(base({ lpLockedByConstruction: true, creatorDevbuyPct: 10 }));
    expect(Object.keys(r.probabilities)).toHaveLength(7); // 5 risk cells + TRADING_ALIVE x2
    expect(r.probabilities['SELL_IMPAIRED@24h']).toBeUndefined();
    expect(r.probabilities['INSIDER_EXIT@24h']).toBe(0.8);
    expect(r.probabilities['TRADING_ALIVE@24h']).toBeCloseTo(0.2, 6); // fired -> low P(alive)
  });
});

describe('det_v0 (spec §4)', () => {
  it('the frozen weights cover every outcome cell', () => {
    expect(DET_V0_WEIGHTS.version).toBe('det_v0');
    for (const k of ALL_OUTCOME_KEYS) expect(DET_V0_WEIGHTS.outcomes[k]).toBeDefined();
  });

  it('produces a probability in [0,1] for all cells on a raw launch', () => {
    const r = detV0(base({ creatorDevbuyPct: 2, uniqueBuyers10m: 40 }));
    expect(Object.keys(r.probabilities)).toHaveLength(11);
    for (const p of Object.values(r.probabilities)) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('drops SELL_IMPAIRED / LIQ_IMPAIRED for launchpad-locked tokens', () => {
    const r = detV0(base({ lpLockedByConstruction: true }));
    expect(Object.keys(r.probabilities).sort()).toEqual(
      ['DRAWDOWN_80@24h', 'DRAWDOWN_80@7d', 'INSIDER_EXIT@24h', 'INSIDER_EXIT@6h', 'INSIDER_EXIT@72h', 'TRADING_ALIVE@24h', 'TRADING_ALIVE@7d'].sort(),
    );
  });

  it('scores a manipulated launch higher for INSIDER_EXIT than a clean one', () => {
    const clean = detV0(
      base({
        creatorDevbuyPct: 0,
        creatorAgeDays: 400,
        uniqueBuyers10m: 120,
        clusterSupplyPct: 1,
        top10NoncreatorPct: 12,
        hasX: true,
        hasSite: true,
      }),
    ).probabilities['INSIDER_EXIT@24h']!;
    const dirty = detV0(
      base({
        creatorDevbuyPct: 18,
        creatorAgeDays: 1,
        uniqueBuyers10m: 4,
        clusterSupplyPct: 35,
        top10NoncreatorPct: 60,
        launchBlockClusterSize: 5,
        creatorPriorInsiderExitRate: 0.8,
      }),
    ).probabilities['INSIDER_EXIT@24h']!;
    expect(dirty).toBeGreaterThan(clean);
    expect(dirty).toBeGreaterThan(0.4);
    expect(clean).toBeLessThan(0.2);
  });

  it('is monotone in creator_devbuy_pct for INSIDER_EXIT', () => {
    const p = (x: number) => detV0(base({ creatorDevbuyPct: x })).probabilities['INSIDER_EXIT@24h']!;
    expect(p(0)).toBeLessThan(p(10));
    expect(p(10)).toBeLessThan(p(30));
  });

  it('tolerates an all-null feature vector', () => {
    const r = detV0(base());
    expect(Object.keys(r.probabilities)).toHaveLength(11);
    for (const val of Object.values(r.probabilities)) expect(Number.isFinite(val)).toBe(true);
  });
});
