import { describe, expect, it } from 'vitest';
import { estimateCostUsd, modelPrice, MODEL_PRICES, PRICING_VERSION } from '../src/deepdive/pricing';

describe('pricing — token-priced cost estimates (M5c)', () => {
  it('prices the pinned deep-dive model from published per-M rates', () => {
    // 50k prompt @ $2/M + 5k completion @ $6/M = $0.10 + $0.03
    expect(estimateCostUsd('sakana/fugu-max', 50_000, 5_000)).toBeCloseTo(0.13, 6);
  });

  it('rounds to micro-dollars', () => {
    expect(estimateCostUsd('deepseek/deepseek-v4.1-flash', 1, 1)).toBe(0.000001);
  });

  it('returns null — never a guess — for an unpriced model', () => {
    expect(modelPrice('~openai/gpt-sol-latest')).toBeNull();
    expect(estimateCostUsd('~openai/gpt-sol-latest', 1000, 100)).toBeNull();
  });

  it('returns null when a token count is missing or invalid', () => {
    expect(estimateCostUsd('sakana/fugu-max', null, 100)).toBeNull();
    expect(estimateCostUsd('sakana/fugu-max', 100, undefined)).toBeNull();
    expect(estimateCostUsd('sakana/fugu-max', -1, 100)).toBeNull();
    expect(estimateCostUsd('sakana/fugu-max', Number.NaN, 100)).toBeNull();
  });

  it('zero tokens is a valid (free) run, not unavailable', () => {
    expect(estimateCostUsd('sakana/fugu-max', 0, 0)).toBe(0);
  });

  it('every price table entry is an exact slug, never an alias', () => {
    for (const slug of Object.keys(MODEL_PRICES)) expect(slug.startsWith('~')).toBe(false);
    expect(PRICING_VERSION).toMatch(/^openrouter-\d{4}-\d{2}-\d{2}$/);
  });
});
