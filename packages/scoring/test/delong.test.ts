import { describe, expect, it } from 'vitest';
import { fastDeLong, normalCdf } from '../src/delong';

describe('normalCdf', () => {
  it('matches known quantiles', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe('fastDeLong', () => {
  // 24 obs, alternating labels
  const labels = Array.from({ length: 24 }, (_, i) => i % 2 === 0);
  const perfect = labels.map((y) => (y ? 0.9 : 0.1));
  const noisy = labels.map((_, i) => (i % 3 === 0 ? 0.6 : 0.5)); // near-random

  it('detects a significant AUROC gap for the better forecaster', () => {
    const r = fastDeLong(perfect, noisy, labels)!;
    expect(r.aucA).toBeCloseTo(1, 6);
    expect(r.diff).toBeGreaterThan(0.3);
    expect(r.p).toBeLessThan(0.05);
  });

  it('reports no difference when the two are identical', () => {
    const r = fastDeLong(perfect, perfect, labels)!;
    expect(r.diff).toBe(0);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  it('returns null without at least two of each class', () => {
    expect(fastDeLong([0.1, 0.2], [0.3, 0.4], [true, false])).toBeNull();
  });
});
