import { describe, expect, it } from 'vitest';
import {
  auprc,
  auroc,
  brierScore,
  brierSkill,
  ece,
  logLoss,
  precisionRecallAt,
} from '../src/metrics';

describe('auroc', () => {
  it('is 1 for perfect separation and 0 when reversed', () => {
    expect(auroc([0.1, 0.2, 0.8, 0.9], [false, false, true, true])).toBe(1);
    expect(auroc([0.9, 0.8, 0.2, 0.1], [false, false, true, true])).toBe(0);
  });
  it('is 0.5 when every score ties', () => {
    expect(auroc([0.5, 0.5, 0.5, 0.5], [true, false, true, false])).toBe(0.5);
  });
  it('is null for a single class or empty input', () => {
    expect(auroc([0.1, 0.2], [true, true])).toBeNull();
    expect(auroc([], [])).toBeNull();
  });
});

describe('auprc', () => {
  it('is 1 when positives rank first', () => {
    expect(auprc([0.9, 0.8, 0.2, 0.1], [true, true, false, false])).toBe(1);
  });
  it('is null with no positives', () => {
    expect(auprc([0.1, 0.2], [false, false])).toBeNull();
  });
});

describe('logLoss / brier', () => {
  it('logLoss of 0.5 on a coin flip is ln 2', () => {
    expect(logLoss([0.5, 0.5], [true, false])!).toBeCloseTo(Math.log(2), 6);
  });
  it('brier is 0 for confident correct predictions', () => {
    expect(brierScore([1, 0], [true, false])).toBe(0);
    expect(brierScore([0.5, 0.5], [true, false])).toBe(0.25);
  });
  it('brierSkill is positive when the model beats the reference', () => {
    expect(brierSkill(0.1, 0.25)).toBeCloseTo(0.6, 6);
    expect(brierSkill(0.1, 0)).toBeNull();
  });
});

describe('ece', () => {
  it('is 0 when confidence matches accuracy in each bin', () => {
    expect(ece([0, 0, 0, 0], [false, false, false, false])).toBe(0);
  });
  it('is ~1 when fully confident and always wrong', () => {
    expect(ece([1, 1, 1], [false, false, false])!).toBeGreaterThan(0.999);
  });
});

describe('precisionRecallAt', () => {
  it('counts tp/fp/fn at the threshold', () => {
    // preds: T, F, F ; labels: T, F, T  -> tp 1, fp 0, fn 1
    const r = precisionRecallAt([0.6, 0.4, 0.3], [true, false, true], 0.5);
    expect(r).toMatchObject({ tp: 1, fp: 0, fn: 1 });
    expect(r.precision).toBe(1);
    expect(r.recall).toBeCloseTo(0.5, 6);
  });
});
