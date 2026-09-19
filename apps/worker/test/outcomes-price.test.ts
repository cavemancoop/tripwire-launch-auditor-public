import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { ResolverContext } from '../src/outcomes/context';
import { resolveDrawdown } from '../src/outcomes/resolve-drawdown';
import { resolveSellImpaired } from '../src/outcomes/resolve-sell-impaired';
import type { PoolRef } from '../src/outcomes/series';
import { encodeQuoterReturn, sqrtForPrice, v4SwapLog } from './fixtures/logs';

const POOL_ID = `0x${'22'.repeat(32)}` as Hex;
const TOKEN = '0x00000000000000000000000000000000000000ff';
const QUOTE = '0x0000000000000000000000000000000000000011'; // sorts below TOKEN

const V4_POOL: PoolRef = {
  poolKind: 'v4',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  poolAddress: null,
  poolId: POOL_ID,
  tokenIsCurrency0: false, // TOKEN > QUOTE
};

const baseCtx = (over: Partial<ResolverContext>): ResolverContext => ({
  client: over.client!,
  chainId: 4663,
  maxRange: 2000,
  pool: V4_POOL,
  token: TOKEN,
  quote: QUOTE,
  poolKey: {
    currency0: QUOTE as Hex,
    currency1: TOKEN as Hex,
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
  },
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  quoteDecimals: 6,
  launchBlock: 5n,
  lpLockedByConstruction: false,
  clusterWallets: [],
  label: 'DRAWDOWN_80',
  horizon: '24h',
  trigger: 'launch',
  anchorBlock: 10n,
  horizonBlock: 200n,
  drawdownRefStart: 10n,
  drawdownRefEnd: 100n,
  ...over,
});

// TOKEN is currency1 so tokenPriceInQuote inverts; feed sqrt for 1/price
const priceLog = (price: number, block: bigint) =>
  v4SwapLog(POOL_ID, sqrtForPrice(1 / price), block);

const logClient = (logs: Array<{ blockNumber: string }>) => ({
  request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
    if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
    const from = BigInt(params[0].fromBlock);
    const to = BigInt(params[0].toBlock);
    return logs.filter((l) => {
      const b = BigInt(l.blockNumber);
      return b >= from && b <= to;
    });
  }),
});

describe('resolveDrawdown', () => {
  it('true when the horizon price is <= 20% of the reference max', async () => {
    const client = logClient([priceLog(100, 50n), priceLog(90, 80n), priceLog(12, 150n)]);
    const r = await resolveDrawdown(baseCtx({ client: client as never }));
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(true);
    expect((r.evidence as { horizonSource: string }).horizonSource).toBe('swap');
  });

  it('false when the horizon price holds above the floor', async () => {
    const client = logClient([priceLog(100, 50n), priceLog(60, 150n)]);
    const r = await resolveDrawdown(baseCtx({ client: client as never }));
    expect(r.value).toBe(false);
  });

  it('unresolvable when there is no price in the reference window', async () => {
    const client = logClient([]);
    const r = await resolveDrawdown(baseCtx({ client: client as never }));
    expect(r.status).toBe('UNRESOLVABLE');
    expect(r.reason).toMatch(/reference window/);
  });

  it('falls back to a quoter spot price when the token went silent after the reference window', async () => {
    const refOnly = [priceLog(100, 50n)]; // in [10,100], nothing after
    const client = {
      request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
        if (method === 'eth_getLogs') {
          const from = BigInt(params[0].fromBlock);
          const to = BigInt(params[0].toBlock);
          return refOnly.filter((l) => {
            const b = BigInt(l.blockNumber);
            return b >= from && b <= to;
          });
        }
        if (method === 'eth_call') return encodeQuoterReturn(10n * 10n ** 15n); // out/in = 10
        throw new Error(method);
      }),
    };
    const r = await resolveDrawdown(baseCtx({ client: client as never }));
    expect(r.value).toBe(true); // 10 / 100 = 0.1
    expect((r.evidence as { horizonSource: string }).horizonSource).toBe('quote');
  });
});

describe('resolveSellImpaired', () => {
  const quoterClient = (perCall: Array<bigint | 'revert' | Error>) => {
    let n = 0;
    return {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method !== 'eth_call') throw new Error(method);
        const r = perCall[n++];
        if (r instanceof Error) throw r;
        if (r === 'revert') throw new Error('execution reverted');
        return encodeQuoterReturn(r as bigint);
      }),
    };
  };

  it('NA for launchpad tokens', async () => {
    const r = await resolveSellImpaired(
      baseCtx({ client: quoterClient([]) as never, lpLockedByConstruction: true, label: 'SELL_IMPAIRED' }),
    );
    expect(r.status).toBe('NA');
  });

  it('unresolvable on a missing-archive error, never false', async () => {
    const r = await resolveSellImpaired(
      baseCtx({
        client: quoterClient([new Error('missing trie node deadbeef')]) as never,
        label: 'SELL_IMPAIRED',
      }),
    );
    expect(r.status).toBe('UNRESOLVABLE');
    expect(r.reason).toMatch(/archive/);
  });

  it('unresolvable when the spot quote reverts, never true (bad poolKey vs honeypot is ambiguous)', async () => {
    const r = await resolveSellImpaired(
      baseCtx({ client: quoterClient(['revert']) as never, label: 'SELL_IMPAIRED' }),
    );
    expect(r.status).toBe('UNRESOLVABLE');
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/revert/);
  });

  it('unresolvable when the bulk quote reverts after a good spot quote', async () => {
    const r = await resolveSellImpaired(
      baseCtx({ client: quoterClient([10n ** 12n, 'revert']) as never, label: 'SELL_IMPAIRED' }),
    );
    expect(r.status).toBe('UNRESOLVABLE');
    expect(r.value).toBeNull();
  });

  it('true when the bulk quote returns 0 after a good spot quote', async () => {
    const r = await resolveSellImpaired(
      baseCtx({ client: quoterClient([10n ** 12n, 0n]) as never, label: 'SELL_IMPAIRED' }),
    );
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(true);
  });

  it('false for a low effective tax', async () => {
    // spot: in 1e12 -> out 1e12 (spotPer 1). bulk out 0.97 * size -> 3% tax
    const r = await resolveSellImpaired(
      baseCtx({
        client: quoterClient([10n ** 12n, (100n * 10n ** 6n * 97n) / 100n]) as never,
        label: 'SELL_IMPAIRED',
      }),
    );
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(false);
    expect((r.evidence as { taxBps: number }).taxBps).toBeLessThan(500);
  });

  it('true for an effective tax >= 30%', async () => {
    const r = await resolveSellImpaired(
      baseCtx({
        client: quoterClient([10n ** 12n, (100n * 10n ** 6n * 50n) / 100n]) as never,
        label: 'SELL_IMPAIRED',
      }),
    );
    expect(r.value).toBe(true);
    expect((r.evidence as { taxBps: number }).taxBps).toBeGreaterThanOrEqual(3000);
  });
});
