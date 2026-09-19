import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { blockAtTime, clearBlockTimeCache } from '../src/outcomes/block-time';
import { buildLiquiditySeries, buildPriceSeries, type PoolRef } from '../src/outcomes/series';
import { sqrtForPrice, v4ModLiqLog, v4SwapLog } from './fixtures/logs';

const POOL_ID = `0x${'11'.repeat(32)}` as Hex;
const V4_POOL: PoolRef = {
  poolKind: 'v4',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  poolAddress: null,
  poolId: POOL_ID,
  tokenIsCurrency0: true,
};

const logClientReturning = (logs: unknown[]) => ({
  request: vi.fn(async ({ method }: { method: string }) => {
    if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
    return logs;
  }),
});

describe('buildPriceSeries (v4)', () => {
  it('decodes swaps to prices, oldest first, with a coverage record', async () => {
    const logs = [
      v4SwapLog(POOL_ID, sqrtForPrice(100), 30n),
      v4SwapLog(POOL_ID, sqrtForPrice(10), 50n),
      v4SwapLog(POOL_ID, sqrtForPrice(40), 20n),
    ];
    const { points, coverage } = await buildPriceSeries(
      logClientReturning(logs) as never,
      V4_POOL,
      10n,
      60n,
      2000,
    );
    expect(points.map((p) => Number(p.block))).toEqual([20, 30, 50]);
    expect(points[0]!.price).toBeCloseTo(40, 0);
    expect(Math.max(...points.map((p) => p.price))).toBeCloseTo(100, 0);
    expect(coverage.callCount).toBe(1);
    expect(coverage.blocksScanned).toBe(51);
  });

  it('flags an empty window', async () => {
    const { points, coverage } = await buildPriceSeries(
      logClientReturning([]) as never,
      V4_POOL,
      100n,
      50n,
      2000,
    );
    expect(points).toEqual([]);
    expect(coverage.gaps.join(' ')).toMatch(/empty window/);
  });
});

describe('buildLiquiditySeries (v4)', () => {
  it('accumulates ModifyLiquidity deltas and marks removals', async () => {
    const logs = [
      v4ModLiqLog(POOL_ID, 1000n, 10n),
      v4ModLiqLog(POOL_ID, 500n, 20n),
      v4ModLiqLog(POOL_ID, -1300n, 30n),
    ];
    const { points } = await buildLiquiditySeries(
      logClientReturning(logs) as never,
      V4_POOL,
      0n,
      40n,
      2000,
    );
    expect(points.map((p) => p.liquidity)).toEqual([1000, 1500, 200]);
    expect(points[2]!.delta).toBe(-1300);
  });

  it('reports a gap when there are no liquidity events', async () => {
    const { points, coverage } = await buildLiquiditySeries(
      logClientReturning([]) as never,
      V4_POOL,
      0n,
      40n,
      2000,
    );
    expect(points).toEqual([]);
    expect(coverage.gaps.join(' ')).toMatch(/no ModifyLiquidity/);
  });
});

describe('blockAtTime', () => {
  beforeEach(() => clearBlockTimeCache());

  // synthetic chain: timestamp === blockNumber (seconds)
  const clock = {
    getBlockNumber: vi.fn(async () => 1000n),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      timestamp: blockNumber,
    })),
  };

  it('finds the last block at or before a time', async () => {
    const b = await blockAtTime(clock as never, new Date(500 * 1000));
    expect(b).toBe(500n);
  });

  it('clamps to head when the time is in the future', async () => {
    const b = await blockAtTime(clock as never, new Date(9_999 * 1000));
    expect(b).toBe(1000n);
  });

  it('clamps to the low bound when the time precedes it', async () => {
    const b = await blockAtTime(clock as never, new Date(0));
    expect(b).toBe(1n);
  });
});
