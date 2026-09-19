import { describe, expect, it } from 'vitest';
import { goplusToProbabilities, scanhoodToProbabilities } from '../src/mappings';
import { ALL_OUTCOME_KEYS, outcomeIsPositive } from '../src/types';

const risk = ALL_OUTCOME_KEYS.filter((k) => !outcomeIsPositive(k));
const alive = ALL_OUTCOME_KEYS.filter(outcomeIsPositive);

describe('scanhoodToProbabilities', () => {
  it('is empty for a missing scan', () => {
    expect(scanhoodToProbabilities(null)).toEqual({});
  });

  it('rates a honeypot high on risk, low on survival, pins SELL_IMPAIRED', () => {
    const p = scanhoodToProbabilities({ verdict: 'honeypot', sellable: false, verified: false });
    for (const k of risk) expect(p[k]!).toBeGreaterThan(0.5);
    for (const k of alive) expect(p[k]!).toBeLessThan(0.5); // low P(still trading)
    expect(p['SELL_IMPAIRED@24h']!).toBeGreaterThanOrEqual(0.85);
    expect(Math.max(...Object.values(p))).toBeLessThanOrEqual(0.97);
  });

  it('rates a clean token low on risk, high on survival', () => {
    const p = scanhoodToProbabilities({ verdict: 'safe', sellable: true, verified: true, deployer: { launches: 12 } });
    for (const k of risk) expect(p[k]!).toBeLessThan(0.2);
    for (const k of alive) expect(p[k]!).toBeGreaterThan(0.8);
  });
});

describe('goplusToProbabilities', () => {
  it('is empty for a missing scan', () => {
    expect(goplusToProbabilities(undefined)).toEqual({});
  });

  it('elevates risk when honeypot / mintable flags are set', () => {
    const risky = goplusToProbabilities({ is_honeypot: '1', is_mintable: '1', sell_tax: '0.25' });
    const clean = goplusToProbabilities({});
    expect(risky['DRAWDOWN_80@24h']!).toBeGreaterThan(clean['DRAWDOWN_80@24h']!);
    expect(risky['TRADING_ALIVE@24h']!).toBeLessThan(clean['TRADING_ALIVE@24h']!);
    expect(risky['SELL_IMPAIRED@1h']!).toBeGreaterThan(0.4);
    expect(Math.max(...Object.values(risky))).toBeLessThanOrEqual(0.97);
  });

  it('keeps a flag-free token near the base rate', () => {
    const p = goplusToProbabilities({ is_honeypot: '0' });
    for (const k of risk) expect(p[k]!).toBeLessThan(0.1);
    for (const k of alive) expect(p[k]!).toBeGreaterThan(0.9);
  });
});
