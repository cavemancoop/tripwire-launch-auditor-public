import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { ResolverContext } from '../src/outcomes/context';
import { resolveInsiderExit } from '../src/outcomes/resolve-insider';
import { resolveLiqImpaired } from '../src/outcomes/resolve-liq';
import type { PoolRef } from '../src/outcomes/series';
import { transferLog, v4ModLiqLog } from './fixtures/logs';

const POOL_ID = `0x${'33'.repeat(32)}` as Hex;
const TOKEN = '0x1111111111111111111111111111111111111111';
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const C = '0x6666666666666666666666666666666666666666';
const ZERO = '0x0000000000000000000000000000000000000000';

const V4_POOL: PoolRef = {
  poolKind: 'v4',
  poolManager: PM,
  poolAddress: null,
  poolId: POOL_ID,
  tokenIsCurrency0: true,
};

const ctx = (over: Partial<ResolverContext>): ResolverContext => ({
  client: over.client!,
  chainId: 4663,
  maxRange: 2000,
  pool: V4_POOL,
  token: TOKEN,
  quote: '0x0000000000000000000000000000000000000011',
  poolKey: null,
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  quoteDecimals: 6,
  launchBlock: 0n,
  lpLockedByConstruction: false,
  clusterWallets: [C],
  label: 'INSIDER_EXIT',
  horizon: '24h',
  trigger: 'launch',
  anchorBlock: 0n,
  horizonBlock: 100n,
  drawdownRefStart: 0n,
  drawdownRefEnd: 0n,
  ...over,
});

/** route the two getLogs calls: topics[2] set => "to cluster", else "from cluster" */
const transferClient = (fromCluster: unknown[], toCluster: unknown[]) => ({
  request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
    if (method !== 'eth_getLogs') throw new Error(method);
    const topics = params[0].topics as unknown[];
    return topics.length >= 3 && topics[2] ? toCluster : fromCluster;
  }),
});

describe('resolveInsiderExit', () => {
  it('true when the cluster net-sells >= 50% of its peak to the pool', async () => {
    const client = transferClient(
      [transferLog(TOKEN, C, PM, 600n, 50n)],
      [transferLog(TOKEN, ZERO, C, 1000n, 10n)],
    );
    const r = await resolveInsiderExit(ctx({ client: client as never }));
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(true);
    expect((r.evidence as { peakHoldings: string }).peakHoldings).toBe('1000');
  });

  it('false when the net sell is under half of peak', async () => {
    const client = transferClient(
      [transferLog(TOKEN, C, PM, 300n, 50n)],
      [transferLog(TOKEN, ZERO, C, 1000n, 10n)],
    );
    const r = await resolveInsiderExit(ctx({ client: client as never }));
    expect(r.value).toBe(false);
  });

  it('false (not unresolvable) when the cluster never held tokens', async () => {
    const client = transferClient([], []);
    const r = await resolveInsiderExit(ctx({ client: client as never }));
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(false);
  });

  it('unresolvable with no cluster wallets', async () => {
    const client = transferClient([], []);
    const r = await resolveInsiderExit(ctx({ client: client as never, clusterWallets: [] }));
    expect(r.status).toBe('UNRESOLVABLE');
  });
});

describe('resolveLiqImpaired', () => {
  const modLiqClient = (logs: unknown[]) => ({
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_getLogs') throw new Error(method);
      return logs;
    }),
  });

  it('true when liquidity falls to <= 20% of peak via a removal', async () => {
    const client = modLiqClient([
      v4ModLiqLog(POOL_ID, 1000n, 10n),
      v4ModLiqLog(POOL_ID, 500n, 20n),
      v4ModLiqLog(POOL_ID, -1300n, 30n),
    ]);
    const r = await resolveLiqImpaired(ctx({ client: client as never, label: 'LIQ_IMPAIRED', horizon: '24h' }));
    expect(r.status).toBe('RESOLVED');
    expect(r.value).toBe(true);
    expect((r.evidence as { removalCount: number }).removalCount).toBe(1);
  });

  it('false when liquidity is retained', async () => {
    const client = modLiqClient([
      v4ModLiqLog(POOL_ID, 1000n, 10n),
      v4ModLiqLog(POOL_ID, 200n, 20n),
    ]);
    const r = await resolveLiqImpaired(ctx({ client: client as never, label: 'LIQ_IMPAIRED' }));
    expect(r.value).toBe(false);
  });

  it('NA for launchpad tokens', async () => {
    const r = await resolveLiqImpaired(
      ctx({ client: modLiqClient([]) as never, label: 'LIQ_IMPAIRED', lpLockedByConstruction: true }),
    );
    expect(r.status).toBe('NA');
  });

  it('unresolvable when there are no liquidity events', async () => {
    const r = await resolveLiqImpaired(
      ctx({ client: modLiqClient([]) as never, label: 'LIQ_IMPAIRED' }),
    );
    expect(r.status).toBe('UNRESOLVABLE');
  });
});
