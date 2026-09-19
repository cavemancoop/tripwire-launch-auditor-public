import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { ResolverContext } from '../src/outcomes/context';
import { resolveSurvival } from '../src/outcomes/resolve-survival';
import type { PoolRef } from '../src/outcomes/series';
import { sqrtForPrice, v4SwapLog } from './fixtures/logs';

const POOL_ID = `0x${'44'.repeat(32)}` as Hex;
const V4_POOL: PoolRef = {
  poolKind: 'v4',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  poolAddress: null,
  poolId: POOL_ID,
  tokenIsCurrency0: true,
};

const ctx = (over: Partial<ResolverContext>): ResolverContext => ({
  client: over.client!,
  chainId: 4663,
  maxRange: 10_000,
  pool: V4_POOL,
  token: '0x00000000000000000000000000000000000000ff',
  quote: '0x0000000000000000000000000000000000000011',
  poolKey: null,
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  quoteDecimals: 6,
  launchBlock: 5n,
  lpLockedByConstruction: false,
  clusterWallets: [],
  label: 'TRADING_ALIVE',
  horizon: '24h',
  trigger: 'launch',
  anchorBlock: 10n,
  horizonBlock: 1_000_000n,
  drawdownRefStart: 0n,
  drawdownRefEnd: 0n,
  ...over,
});

const logClient = (logs: Array<{ blockNumber: string }>) => ({
  request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
    if (method !== 'eth_getLogs') throw new Error(method);
    const from = BigInt(params[0].fromBlock);
    const to = BigInt(params[0].toBlock);
    return logs.filter((l) => {
      const b = BigInt(l.blockNumber);
      return b >= from && b <= to;
    });
  }),
});

describe('resolveSurvival (TRADING_ALIVE)', () => {
  it('true when there is a trade in the 6h window before the horizon', async () => {
    const client = logClient([v4SwapLog(POOL_ID, sqrtForPrice(1), 950_000n)]);
    const r = await resolveSurvival(ctx({ client: client as never }));
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(true);
    expect((r.evidence as { tradesInWindow: number }).tradesInWindow).toBe(1);
  });

  it('false when the last trade is older than the window', async () => {
    // trade at block 700k, window is [1_000_000 - 216_000, 1_000_000] = [784k, 1M]
    const client = logClient([v4SwapLog(POOL_ID, sqrtForPrice(1), 700_000n)]);
    const r = await resolveSurvival(ctx({ client: client as never }));
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(false);
  });

  it('unresolvable (not false) when the window scan errors', async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error('upstream RPC error');
      }),
    };
    const r = await resolveSurvival(ctx({ client: client as never }));
    expect(r.status).toBe('UNRESOLVABLE');
    expect(r.value).toBeNull();
  });
});
