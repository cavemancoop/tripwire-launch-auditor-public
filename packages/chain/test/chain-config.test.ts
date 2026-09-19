import { describe, expect, it } from 'vitest';
import { getChainConfig, poolCreationSources } from '../src/chain-config';

describe('getChainConfig', () => {
  it('returns the Robinhood Chain (4663) config', () => {
    const c = getChainConfig(4663);
    expect(c.chainId).toBe(4663);
    expect(c.uniswap.v4PoolManager.address.toLowerCase()).toBe(
      '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    );
    expect(c.uniswap.v4PoolManager.verified).toBe(true);
    expect(c.getLogsMaxRange).toBeGreaterThan(0);
  });

  it('throws for an unconfigured chain', () => {
    expect(() => getChainConfig(1)).toThrow(/no chain config/);
  });
});

describe('poolCreationSources', () => {
  it('lists v2 + v3 (with alternates) + v4 addresses, lowercased', () => {
    const s = poolCreationSources(4663);
    expect(s.v4PoolManager).toBe('0x8366a39cc670b4001a1121b8f6a443a643e40951');
    expect(s.v2Factory).toMatch(/^0x[0-9a-f]{40}$/);
    expect(s.v3Factories.length).toBeGreaterThanOrEqual(2);
    for (const a of s.v3Factories) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
