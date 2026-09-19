import {
  getLogsChunked,
  TRADE_EVENT_TOPIC0,
  decodeV2Sync,
  decodeV3Swap,
  decodeV4ModifyLiquidity,
  decodeV4Swap,
  tokenPriceInQuote,
  type RpcLog,
} from '@launch-auditor/chain';
import type { Hex } from 'viem';
import { withRetry } from '../watcher/retry';
import { newCoverage, type Coverage } from './coverage';

export type LogClient = Parameters<typeof getLogsChunked>[0];

/**
 * getLogsChunked with a light outer retry. The budgeted transport already
 * retries each individual `eth_getLogs` on rate-limit / "busy" errors, and this
 * outer wrapper restarts the *entire* multi-chunk scan from block 0 on any
 * failure — so keep it to 2 tries, else a flaky endpoint + an 80-chunk window
 * never completes (the 24h backfill hang).
 */
const chunkedLogs = (
  client: LogClient,
  params: Parameters<typeof getLogsChunked>[1],
): Promise<RpcLog[]> => withRetry(() => getLogsChunked(client, params), { tries: 2, delayMs: 1500 });

export interface PoolRef {
  poolKind: 'v2' | 'v3' | 'v4';
  /** v4 PoolManager singleton (v4) */
  poolManager: string;
  /** v2/v3 pool contract */
  poolAddress: string | null;
  /** v4 bytes32 pool id */
  poolId: string | null;
  /** the new token holds currency0 (v4) / token0 (v2/v3)? */
  tokenIsCurrency0: boolean;
}

export interface PricePoint {
  block: bigint;
  price: number;
  txHash: string | null;
}

export interface Series<T> {
  points: T[];
  coverage: Coverage;
}

function countCalls(fromBlock: bigint, toBlock: bigint, chunk: number): number {
  const span = toBlock >= fromBlock ? Number(toBlock - fromBlock) + 1 : 0;
  return chunk > 0 ? Math.ceil(span / chunk) : 0;
}

const MAX_SERIES_LOGS = 40_000;

/** Trade prices over [fromBlock, toBlock], oldest first, decimals not applied. */
export async function buildPriceSeries(
  client: LogClient,
  pool: PoolRef,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<Series<PricePoint>> {
  const coverage = newCoverage(fromBlock, toBlock, maxRange);
  coverage.callCount = countCalls(fromBlock, toBlock, maxRange);
  if (toBlock < fromBlock) {
    coverage.gaps.push('empty window (toBlock < fromBlock)');
    return { points: [], coverage };
  }

  let logs: RpcLog[];
  if (pool.poolKind === 'v4') {
    if (!pool.poolId) {
      coverage.gaps.push('v4 pool has no poolId');
      return { points: [], coverage };
    }
    logs = await chunkedLogs(client, {
      address: pool.poolManager as Hex,
      topics: [TRADE_EVENT_TOPIC0.v4Swap as Hex, pool.poolId as Hex],
      fromBlock,
      toBlock,
      maxRange,
    });
  } else {
    if (!pool.poolAddress) {
      coverage.gaps.push(`${pool.poolKind} pool has no poolAddress`);
      return { points: [], coverage };
    }
    const topic0 = pool.poolKind === 'v3' ? TRADE_EVENT_TOPIC0.v3Swap : TRADE_EVENT_TOPIC0.v2Sync;
    logs = await chunkedLogs(client, {
      address: pool.poolAddress as Hex,
      topics: [topic0 as Hex],
      fromBlock,
      toBlock,
      maxRange,
    });
  }

  if (logs.length >= MAX_SERIES_LOGS) {
    coverage.gaps.push(`log cap hit (${logs.length} >= ${MAX_SERIES_LOGS}); series truncated`);
  }

  const points: PricePoint[] = [];
  for (const log of logs) {
    if (pool.poolKind === 'v4') {
      const s = decodeV4Swap(log);
      if (!s?.sqrtPriceX96) continue;
      points.push({
        block: s.block,
        price: tokenPriceInQuote(s.sqrtPriceX96, pool.tokenIsCurrency0),
        txHash: s.txHash,
      });
    } else if (pool.poolKind === 'v3') {
      const s = decodeV3Swap(log);
      if (!s?.sqrtPriceX96) continue;
      points.push({
        block: s.block,
        price: tokenPriceInQuote(s.sqrtPriceX96, pool.tokenIsCurrency0),
        txHash: s.txHash,
      });
    } else {
      const s = decodeV2Sync(log);
      if (!s) continue;
      const r0 = Number(s.reserve0);
      const r1 = Number(s.reserve1);
      if (r0 <= 0 || r1 <= 0) continue;
      points.push({
        block: s.block,
        price: pool.tokenIsCurrency0 ? r1 / r0 : r0 / r1,
        txHash: s.txHash,
      });
    }
  }
  points.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  return { points, coverage };
}

export interface LiquidityPoint {
  block: bigint;
  /** cumulative in-range liquidity (v4) or quote-side reserve (v2) */
  liquidity: number;
  txHash: string | null;
  /** negative when this event removed liquidity */
  delta: number;
}

/**
 * Liquidity depth over [fromBlock, toBlock]. v4: cumulative sum of
 * ModifyLiquidity deltas (starts at 0 at fromBlock, so pass the launch block).
 * v2: the quote-side reserve from Sync. v3: not wired (barely used on 4663).
 */
export async function buildLiquiditySeries(
  client: LogClient,
  pool: PoolRef,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<Series<LiquidityPoint>> {
  const coverage = newCoverage(fromBlock, toBlock, maxRange);
  coverage.callCount = countCalls(fromBlock, toBlock, maxRange);
  if (toBlock < fromBlock) {
    coverage.gaps.push('empty window (toBlock < fromBlock)');
    return { points: [], coverage };
  }

  if (pool.poolKind === 'v4') {
    if (!pool.poolId) {
      coverage.gaps.push('v4 pool has no poolId');
      return { points: [], coverage };
    }
    const logs = await chunkedLogs(client, {
      address: pool.poolManager as Hex,
      topics: [TRADE_EVENT_TOPIC0.v4ModifyLiquidity as Hex, pool.poolId as Hex],
      fromBlock,
      toBlock,
      maxRange,
    });
    const deltas = logs
      .map(decodeV4ModifyLiquidity)
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    let cum = 0n;
    const points: LiquidityPoint[] = deltas.map((d) => {
      cum += d.delta;
      return {
        block: d.block,
        liquidity: Number(cum),
        txHash: d.txHash,
        delta: Number(d.delta),
      };
    });
    if (points.length === 0) coverage.gaps.push('no ModifyLiquidity events for poolId');
    return { points, coverage };
  }

  if (pool.poolKind === 'v2') {
    if (!pool.poolAddress) {
      coverage.gaps.push('v2 pool has no poolAddress');
      return { points: [], coverage };
    }
    const logs = await chunkedLogs(client, {
      address: pool.poolAddress as Hex,
      topics: [TRADE_EVENT_TOPIC0.v2Sync as Hex],
      fromBlock,
      toBlock,
      maxRange,
    });
    const syncs = logs
      .map(decodeV2Sync)
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    let prevQuote = 0;
    const points: LiquidityPoint[] = syncs.map((s) => {
      const quoteReserve = Number(pool.tokenIsCurrency0 ? s.reserve1 : s.reserve0);
      const delta = quoteReserve - prevQuote;
      prevQuote = quoteReserve;
      return { block: s.block, liquidity: quoteReserve, txHash: s.txHash, delta };
    });
    if (points.length === 0) coverage.gaps.push('no Sync events for pool');
    return { points, coverage };
  }

  coverage.gaps.push('v3 liquidity series not implemented');
  return { points: [], coverage };
}
