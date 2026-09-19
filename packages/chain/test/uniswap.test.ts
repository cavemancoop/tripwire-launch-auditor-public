import { isHex, size } from 'viem';
import { describe, expect, it } from 'vitest';
import { POOL_EVENT_TOPIC0, decodePoolCreation, isZeroAddress } from '../src/uniswap';
import v4Initialize from './fixtures/v4-initialize.json';

describe('POOL_EVENT_TOPIC0', () => {
  it('are 32-byte hashes', () => {
    for (const topic of Object.values(POOL_EVENT_TOPIC0)) {
      expect(isHex(topic)).toBe(true);
      expect(size(topic)).toBe(32);
    }
  });

  it('matches the canonical Uniswap event selectors', () => {
    expect(POOL_EVENT_TOPIC0.v4Initialize).toBe(
      '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
    );
    expect(POOL_EVENT_TOPIC0.v3PoolCreated).toBe(
      '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
    );
    expect(POOL_EVENT_TOPIC0.v2PairCreated).toBe(
      '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
    );
  });
});

describe('decodePoolCreation', () => {
  it('decodes a real Robinhood Chain v4 Initialize log', () => {
    const pool = decodePoolCreation(v4Initialize);
    expect(pool).not.toBeNull();
    expect(pool!.poolKind).toBe('v4');
    expect(pool!.detectedVia).toBe('v4:Initialize');
    expect(pool!.poolId).toBe(v4Initialize.topics[1]);
    expect(pool!.token0.toLowerCase()).toBe('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
    expect(pool!.token1.toLowerCase()).toBe('0xf630559b24d6d3186efa9fdf577dea6adb4b1337');
    expect(pool!.fee).toBe(100000);
    expect(pool!.tickSpacing).toBe(2000);
    expect(isZeroAddress(pool!.hooks)).toBe(true);
    expect(pool!.poolAddress).toBeNull();
  });

  it('returns null for a log with an unrelated topic0', () => {
    expect(
      decodePoolCreation({ address: '0x0', topics: ['0xdeadbeef'], data: '0x' }),
    ).toBeNull();
  });
});
