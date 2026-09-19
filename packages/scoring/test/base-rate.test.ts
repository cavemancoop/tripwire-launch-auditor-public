import { describe, expect, it } from 'vitest';
import { baseRate, brier, brierSkillScore, outcomeKey } from '../src/index';

describe('baseRate', () => {
  it('is the fraction of positives', () => {
    expect(baseRate([true, true, false, false])).toBe(0.5);
    expect(baseRate([false, false, false, false])).toBe(0);
  });
  it('is 0 for an empty set', () => {
    expect(baseRate([])).toBe(0);
  });
});

describe('brier', () => {
  it('is 0 for perfect confident forecasts', () => {
    expect(brier([1, 0, 1], [true, false, true])).toBe(0);
  });
  it('is 0.25 for hedged forecasts', () => {
    expect(brier([0.5, 0.5], [true, false])).toBe(0.25);
  });
  it('rejects mismatched lengths', () => {
    expect(() => brier([0.5], [true, false])).toThrow(/length/);
  });
});

describe('brierSkillScore', () => {
  it('is positive when the model beats the reference', () => {
    expect(brierSkillScore(0.1, 0.2)).toBeCloseTo(0.5);
  });
  it('is 0 when model equals reference', () => {
    expect(brierSkillScore(0.2, 0.2)).toBe(0);
  });
});

describe('outcomeKey', () => {
  it('joins label and horizon', () => {
    expect(outcomeKey('INSIDER_EXIT', '24h')).toBe('INSIDER_EXIT@24h');
  });
});
