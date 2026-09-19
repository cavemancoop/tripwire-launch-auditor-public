import { describe, expect, it } from 'vitest';
import { aurocStandardError, isInvertedRanking, scoreBenchmark, type ScoreRow } from '../src/scorer';

/** det_v0 ~85% discriminating, base_rate near-random with small jitter (non-degenerate). */
function rows(n: number): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (let i = 0; i < n; i++) {
    const label = i % 2 === 0;
    const obsId = `tok${i}@t`;
    const trigger = i < n / 2 ? 'launch' : 'qualified';
    const source = i % 3 === 0 ? 'pons' : 'raw';
    const detWrong = i % 7 === 0;
    const detProb =
      label !== detWrong ? 0.62 + (i % 5) * 0.02 : 0.38 - (i % 5) * 0.02;
    const brProb = 0.4 + ((i % 4) - 1.5) * 0.02;
    out.push({ obsId, forecaster: 'det_v0', outcomeKey: 'DRAWDOWN_80@24h', trigger, source, prob: detProb, label });
    out.push({ obsId, forecaster: 'base_rate', outcomeKey: 'DRAWDOWN_80@24h', trigger, source, prob: brProb, label });
  }
  return out;
}

describe('scoreBenchmark', () => {
  it('produces an all section plus trigger and source splits', () => {
    const b = scoreBenchmark(rows(20));
    expect(b.sections.find((s) => s.splitBy === 'all')).toBeDefined();
    expect(b.sections.filter((s) => s.splitBy === 'trigger').map((s) => s.splitValue).sort()).toEqual([
      'launch',
      'qualified',
    ]);
    expect(b.sections.filter((s) => s.splitBy === 'source').map((s) => s.splitValue).sort()).toEqual([
      'pons',
      'raw',
    ]);
  });

  it('withholds every metric below the minimum sample, publishing only counts', () => {
    const all = scoreBenchmark(rows(20)).sections.find((s) => s.splitBy === 'all')!;
    const det = all.byOutcome['DRAWDOWN_80@24h']!.find((c) => c.forecaster === 'det_v0')!;
    expect(det.insufficientSample).toBe(true); // n=20 < 100
    expect(det.n).toBe(20);
    expect(det.positives).toBe(10);
    expect(det.auroc).toBeNull();
    expect(det.brierSkill).toBeNull();
    expect(det.comparisons).toEqual([]);
  });

  it('ranks the better forecaster first and gates claims on sample size', () => {
    const all = scoreBenchmark(rows(160)).sections.find((s) => s.splitBy === 'all')!;
    const cells = all.byOutcome['DRAWDOWN_80@24h']!;
    expect(cells[0]!.forecaster).toBe('det_v0');
    expect(cells[0]!.auroc!).toBeGreaterThan(0.7);
    expect(cells[0]!.insufficientSample).toBe(false);
    const cmp = cells[0]!.comparisons.find((c) => c.vs === 'base_rate')!;
    expect(cmp.claimAllowed).toBe(false); // 160 < 200
    expect(cmp.note).toMatch(/insufficient sample/);
  });

  it('allows a claim once n >= 200 and the gap is significant', () => {
    const all = scoreBenchmark(rows(240)).sections.find((s) => s.splitBy === 'all')!;
    const det = all.byOutcome['DRAWDOWN_80@24h']!.find((c) => c.forecaster === 'det_v0')!;
    expect(det.insufficientSample).toBe(false);
    const cmp = det.comparisons.find((c) => c.vs === 'base_rate')!;
    expect(cmp.aucDiff! > 0).toBe(true);
    expect(cmp.p! < 0.05).toBe(true);
    expect(cmp.claimAllowed).toBe(true);
    expect(cmp.n).toBe(240); // overlap n — Codex Phase A #4 wanted this published per comparison
  });

  it('publishes an insufficient-overlap comparison with n=0, never a bare null', () => {
    // base_rate_fixed rows exist for this cell but share no obsId with det_v0
    // — zero overlap, the "insufficient overlap / single class" DeLong branch.
    const disjoint: ScoreRow[] = [
      ...rows(120),
      { obsId: 'other1', forecaster: 'base_rate_fixed', outcomeKey: 'DRAWDOWN_80@24h', trigger: 'launch', source: 'raw', prob: 0.4, label: true },
      { obsId: 'other2', forecaster: 'base_rate_fixed', outcomeKey: 'DRAWDOWN_80@24h', trigger: 'launch', source: 'raw', prob: 0.4, label: false },
    ];
    const all = scoreBenchmark(disjoint).sections.find((s) => s.splitBy === 'all')!;
    const det = all.byOutcome['DRAWDOWN_80@24h']!.find((c) => c.forecaster === 'det_v0')!;
    const cmp = det.comparisons.find((c) => c.vs === 'base_rate_fixed')!;
    expect(cmp.n).toBe(0);
    expect(cmp.claimAllowed).toBe(false);
    expect(cmp.note).toMatch(/insufficient overlap/);
  });
});

describe('base_rate_fixed — a constant climatology baseline', () => {
  // Codex Phase B #3: the rolling `base_rate` is same-stream and time-varying,
  // so its live AUROC came in around 0.37/0.42 instead of the ~0.5 a constant
  // predictor should score. A forecaster that predicts the exact same
  // probability for every observation in a cell should score at chance.
  it('scores at chance (AUROC ~0.5) against a mixed-label cell', () => {
    const n = 200;
    const rows: ScoreRow[] = [];
    for (let i = 0; i < n; i++) {
      const label = i % 2 === 0;
      rows.push({
        obsId: `tok${i}@t`,
        forecaster: 'base_rate_fixed',
        outcomeKey: 'DRAWDOWN_80@24h',
        trigger: 'launch',
        source: 'raw',
        prob: 0.5, // the whole-sample prevalence in this fixture is exactly 0.5
        label,
      });
    }
    const all = scoreBenchmark(rows, { baselines: [] }).sections.find((s) => s.splitBy === 'all')!;
    const c = all.byOutcome['DRAWDOWN_80@24h']!.find((x) => x.forecaster === 'base_rate_fixed')!;
    expect(c.auroc).toBe(0.5);
  });

  it('is one of the default DeLong baselines alongside base_rate and heuristic_v1', () => {
    const rows: ScoreRow[] = [];
    for (let i = 0; i < 120; i++) {
      const label = i % 2 === 0;
      rows.push({ obsId: `a${i}`, forecaster: 'det_v0', outcomeKey: 'DRAWDOWN_80@24h', trigger: 'launch', source: 'raw', prob: label ? 0.8 : 0.3, label });
      rows.push({ obsId: `a${i}`, forecaster: 'base_rate_fixed', outcomeKey: 'DRAWDOWN_80@24h', trigger: 'launch', source: 'raw', prob: 0.5, label });
    }
    const all = scoreBenchmark(rows).sections.find((s) => s.splitBy === 'all')!;
    const det = all.byOutcome['DRAWDOWN_80@24h']!.find((x) => x.forecaster === 'det_v0')!;
    expect(det.comparisons.map((c) => c.vs)).toContain('base_rate_fixed');
  });
});

/** n rows, but only `positives` of them are true — a rare-event cell. */
function rareRows(n: number, positives: number): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (let i = 0; i < n; i++) {
    const label = i < positives;
    const obsId = `tok${i}@t`;
    // det_v0 discriminates well; base_rate is near-constant
    const detProb = label ? 0.8 - (i % 5) * 0.01 : 0.2 + (i % 5) * 0.01;
    out.push({ obsId, forecaster: 'det_v0', outcomeKey: 'INSIDER_EXIT@6h', trigger: 'launch', source: 'raw', prob: detProb, label });
    out.push({ obsId, forecaster: 'base_rate', outcomeKey: 'INSIDER_EXIT@6h', trigger: 'launch', source: 'raw', prob: 0.5 + ((i % 4) - 1.5) * 0.01, label });
  }
  return out;
}

const detCell = (b: ReturnType<typeof scoreBenchmark>) =>
  b.sections.find((s) => s.splitBy === 'all')!.byOutcome['INSIDER_EXIT@6h']!.find((c) => c.forecaster === 'det_v0')!;

describe('claim gate — positives rule', () => {
  // A cell can clear 200 observations and still be almost all one class. AUROC
  // on a dozen positives is noise; production hit exactly this (n=336,
  // positives=12) and the gate let it through before the rule was enforced.
  it('refuses a claim when the sample is big but the positives are few', () => {
    const c = detCell(scoreBenchmark(rareRows(400, 12)));
    expect(c.n).toBe(400);
    expect(c.positives).toBe(12);
    const vsBase = c.comparisons.find((x) => x.vs === 'base_rate')!;
    expect(vsBase.claimAllowed).toBe(false);
    expect(vsBase.note).toMatch(/insufficient positives \(12 < 30\)/);
  });

  it('allows a claim once both the sample and the positives clear their bars', () => {
    const c = detCell(scoreBenchmark(rareRows(400, 120)));
    expect(c.positives).toBe(120);
    const vsBase = c.comparisons.find((x) => x.vs === 'base_rate')!;
    expect(vsBase.claimAllowed).toBe(true);
  });

  it('publishes the positives rule alongside the sample rules', () => {
    expect(scoreBenchmark(rareRows(10, 2)).minPositivesForClaims).toBe(30);
  });
});

describe('invertedRanking — "ranks backwards", but only when it is not noise', () => {
  // Figures from the 2026-09-18 production snapshot.
  it('flags det_v0 on DRAWDOWN_80@24h (AUROC 0.344, n=1,227, 231 positives)', () => {
    expect(isInvertedRanking(0.344, 1227, 231)).toBe(true);
  });

  it('does not flag the rolling base_rate at 0.472 on n=5,261 — that is noise around 0.5', () => {
    expect(isInvertedRanking(0.472, 5261, 195)).toBe(false);
  });

  it('never flags below the claim bar, however low the AUROC', () => {
    expect(isInvertedRanking(0.2, 150, 40)).toBe(false); // n < 200
    expect(isInvertedRanking(0.2, 400, 12)).toBe(false); // < 30 positives
    expect(isInvertedRanking(null, 1000, 100)).toBe(false);
  });

  it('matches the Hanley–McNeil standard error on a known case', () => {
    // A=0.344, P=231, N=996 -> SE ≈ 0.0184
    expect(aurocStandardError(0.344, 231, 996)!).toBeCloseTo(0.0184, 3);
  });

  it('is set on a scored cell whose forecaster ranks every positive below every negative', () => {
    const rows: ScoreRow[] = [];
    for (let i = 0; i < 300; i++) {
      const label = i % 3 === 0; // 100 positives
      rows.push({ obsId: `t${i}`, forecaster: 'det_v0', outcomeKey: 'DRAWDOWN_80@24h', trigger: 'launch', source: 'raw', prob: label ? 0.1 + (i % 7) * 0.01 : 0.8 + (i % 7) * 0.01, label });
    }
    const c = scoreBenchmark(rows, { baselines: [] }).sections[0]!.byOutcome['DRAWDOWN_80@24h']![0]!;
    expect(c.auroc).toBe(0);
    expect(c.invertedRanking).toBe(true);
  });
});

describe('claim gates from the 2026-09-19 audit', () => {
  // Audit reproduction: 240 model observations / 40 positives, but only 205
  // overlapping baseline observations / 5 positives, returned claimAllowed:true
  // because the positives gate counted the model's whole cell.
  it('counts positives on the paired rows, not the whole cell', () => {
    const out: ScoreRow[] = [];
    for (let i = 0; i < 240; i++) {
      // first 35 positives are unpaired; the paired 205 carry only 5 positives
      const label = i < 40;
      const detProb = label ? 0.9 - (i % 5) * 0.01 : 0.1 + (i % 5) * 0.01;
      out.push({ obsId: `o${i}`, forecaster: 'det_v0', outcomeKey: 'INSIDER_EXIT@24h', trigger: 'launch', source: 'raw', prob: detProb, label });
      if (i >= 35) {
        out.push({ obsId: `o${i}`, forecaster: 'base_rate', outcomeKey: 'INSIDER_EXIT@24h', trigger: 'launch', source: 'raw', prob: 0.2 + ((i % 4) - 1.5) * 0.01, label });
      }
    }
    const det = scoreBenchmark(out).sections[0]!.byOutcome['INSIDER_EXIT@24h']!.find((c) => c.forecaster === 'det_v0')!;
    expect(det.positives).toBe(40);
    const cmp = det.comparisons.find((c) => c.vs === 'base_rate')!;
    expect(cmp.n).toBe(205);
    expect(cmp.positives).toBe(5);
    expect(cmp.claimAllowed).toBe(false);
    expect(cmp.note).toMatch(/insufficient positives \(5 < 30\)/);
  });

  // Audit: LIQ_IMPAIRED@24h det_v0 AUROC 0.366 carried a green "beats
  // heuristic_v1" badge because the heuristic was even more inverted (0.22).
  it('refuses "beats X" when the forecaster itself ranks below chance', () => {
    const out: ScoreRow[] = [];
    for (let i = 0; i < 400; i++) {
      const label = i % 2 === 0;
      // det inverted but less so than the heuristic
      const det = label ? 0.4 + (i % 7) * 0.02 : 0.5 + (i % 7) * 0.02;
      const heur = label ? 0.1 + (i % 7) * 0.01 : 0.9 - (i % 7) * 0.01;
      out.push({ obsId: `o${i}`, forecaster: 'det_v0', outcomeKey: 'LIQ_IMPAIRED@24h', trigger: 'launch', source: 'raw', prob: det, label });
      out.push({ obsId: `o${i}`, forecaster: 'heuristic_v1', outcomeKey: 'LIQ_IMPAIRED@24h', trigger: 'launch', source: 'raw', prob: heur, label });
    }
    const det = scoreBenchmark(out).sections[0]!.byOutcome['LIQ_IMPAIRED@24h']!.find((c) => c.forecaster === 'det_v0')!;
    expect(det.auroc!).toBeLessThan(0.5);
    const cmp = det.comparisons.find((c) => c.vs === 'heuristic_v1')!;
    expect(cmp.aucDiff!).toBeGreaterThan(0);
    expect(cmp.claimAllowed).toBe(false);
    expect(cmp.note).toMatch(/own AUROC ≤ 0.5/);
  });
});
