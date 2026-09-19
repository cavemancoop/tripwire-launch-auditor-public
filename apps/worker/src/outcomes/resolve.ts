import { getChainConfig, getGetLogsMaxRange } from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import { outcomeApplies, type OutcomeKey } from '@launch-auditor/scoring';
import { erc20Abi, type Hex, type PublicClient } from 'viem';
import { blockAtTime, type BlockTimeClient } from './block-time';
import type { ResolverContext } from './context';
import type { PoolKey } from './quote';
import { resolveDrawdown } from './resolve-drawdown';
import { resolveInsiderExit } from './resolve-insider';
import { resolveLiqImpaired } from './resolve-liq';
import { resolveSellImpaired } from './resolve-sell-impaired';
import { resolveSurvival } from './resolve-survival';
import type { PoolRef } from './series';
import { unresolvable, type Resolution } from './types';

const ZERO = '0x0000000000000000000000000000000000000000';
const H24_MS = 24 * 3600 * 1000;

export type OutcomeRow = {
  id: string;
  chainId: number;
  tokenAddress: string;
  anchorTime: Date;
  trigger: string;
  launchId: string | null;
  label: string;
  horizon: string;
  ruleVersion: string;
  horizonAt: Date | null;
};

export type ResolveClient = BlockTimeClient & Pick<PublicClient, 'request' | 'readContract'>;

const HORIZON_MS: Record<string, number> = {
  '1h': 3600e3,
  '6h': 6 * 3600e3,
  '24h': 24 * 3600e3,
  '72h': 72 * 3600e3,
  '7d': 7 * 24 * 3600e3,
};

const decimalsCache = new Map<string, number>();

async function quoteDecimals(client: ResolveClient, quote: string): Promise<number> {
  if (quote === ZERO) return 18;
  const key = quote.toLowerCase();
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const d = await client.readContract({
      address: quote as Hex,
      abi: erc20Abi,
      functionName: 'decimals',
    });
    const n = Number(d);
    decimalsCache.set(key, n);
    return n;
  } catch {
    decimalsCache.set(key, 18);
    return 18;
  }
}

/** Resolve one outcome row to a verdict. Pure of DB writes — the caller persists. */
export async function resolveOneOutcome(
  client: ResolveClient,
  row: OutcomeRow,
): Promise<Resolution> {
  if (!row.launchId) return unresolvable('no linked launch (non-launch trigger not supported yet)');
  if (!row.horizonAt) return unresolvable('outcome row has no horizonAt');

  const launch = await prisma.launch.findUnique({ where: { id: row.launchId } });
  if (!launch) return unresolvable('linked launch not found');

  const key = `${row.label}@${row.horizon}` as OutcomeKey;
  if (!outcomeApplies(key, { lpLockedByConstruction: launch.lpLockedByConstruction })) {
    return { status: 'NA', value: null, evidence: {}, coverage: null, reason: 'does not apply to this token type' };
  }

  const cfg = getChainConfig(row.chainId);
  const token = launch.tokenAddress.toLowerCase();
  const quote = (launch.quoteAddress ?? ZERO).toLowerCase();
  const poolManager = cfg.uniswap.v4PoolManager.address.toLowerCase();
  const quoter = cfg.uniswap.v4Quoter.address;

  const tokenIsCurrency0 = quote === ZERO ? false : token < quote;

  const pool: PoolRef = {
    poolKind: (launch.poolKind as 'v2' | 'v3' | 'v4' | null) ?? 'v4',
    poolManager,
    poolAddress: launch.poolAddress?.toLowerCase() ?? null,
    poolId: launch.poolId ?? null,
    tokenIsCurrency0,
  };

  let poolKey: PoolKey | null = null;
  if (pool.poolKind === 'v4' && launch.poolFee !== null && launch.poolTickSpacing !== null) {
    // v4 currency ordering: native zero address sorts first, else by address
    const currency0 = quote === ZERO ? ZERO : token < quote ? token : quote;
    const currency1 = quote === ZERO ? token : token < quote ? quote : token;
    poolKey = {
      currency0: currency0 as Hex,
      currency1: currency1 as Hex,
      fee: launch.poolFee,
      tickSpacing: launch.poolTickSpacing,
      hooks: (launch.poolHooks ?? ZERO) as Hex,
    };
  }

  const anchorBlock = await blockAtTime(client, row.anchorTime, { chainId: row.chainId });
  const horizonBlock = await blockAtTime(client, row.horizonAt, { chainId: row.chainId });

  let drawdownRefStart = anchorBlock;
  let drawdownRefEnd = anchorBlock;
  if (row.label === 'DRAWDOWN_80') {
    if (row.trigger === 'launch' || row.trigger === 'qualified') {
      drawdownRefStart = anchorBlock;
      drawdownRefEnd = await blockAtTime(client, new Date(row.anchorTime.getTime() + H24_MS), {
        chainId: row.chainId,
      });
    } else {
      drawdownRefStart = await blockAtTime(client, new Date(row.anchorTime.getTime() - H24_MS), {
        chainId: row.chainId,
      });
      drawdownRefEnd = anchorBlock;
    }
  }

  let clusterWallets: string[] = [];
  if (row.label === 'INSIDER_EXIT') {
    const members = await prisma.clusterMember.findMany({
      where: { launchId: row.launchId },
      select: { address: true },
    });
    clusterWallets = members.map((m) => m.address.toLowerCase());
  }

  const ctx: ResolverContext = {
    client,
    chainId: row.chainId,
    maxRange: getGetLogsMaxRange(row.chainId),
    pool,
    token,
    quote,
    poolKey,
    quoter,
    quoteDecimals: await quoteDecimals(client, quote),
    launchBlock: launch.launchBlock,
    lpLockedByConstruction: launch.lpLockedByConstruction,
    clusterWallets,
    label: row.label,
    horizon: row.horizon,
    trigger: row.trigger,
    anchorBlock,
    horizonBlock,
    drawdownRefStart,
    drawdownRefEnd,
  };

  switch (row.label) {
    case 'DRAWDOWN_80':
      return resolveDrawdown(ctx);
    case 'SELL_IMPAIRED':
      return resolveSellImpaired(ctx);
    case 'LIQ_IMPAIRED':
      return resolveLiqImpaired(ctx);
    case 'INSIDER_EXIT':
      return resolveInsiderExit(ctx);
    case 'TRADING_ALIVE':
      return resolveSurvival(ctx);
    default:
      return unresolvable(`unknown outcome label ${row.label}`);
  }
}

export function horizonMs(horizon: string): number {
  return HORIZON_MS[horizon] ?? 0;
}
