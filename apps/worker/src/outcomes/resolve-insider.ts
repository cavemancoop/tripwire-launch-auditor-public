import { getLogsByTopicValues } from '@launch-auditor/chain';
import type { Hex } from 'viem';
import { addressToTopic, TRANSFER_TOPIC0, topicToAddress, transferValue } from '../watcher/erc20';
import { withRetry } from '../watcher/retry';
import { newCoverage } from './coverage';
import { resolved, unresolvable, type Resolution } from './types';
import type { ResolverContext } from './context';

const MAX_INSIDER_LOGS = 30_000;

/**
 * INSIDER_EXIT (spec §1): the creator cluster (§3.2) net-sells >= 50% of its
 * peak aggregate token holdings by the horizon. A "sell" is a Transfer from a
 * cluster wallet to the pool (v4 PoolManager / v2-v3 pool contract); buys back
 * from the pool net against it. Router-mediated transfers that don't land on the
 * pool address are noted as a coverage gap.
 */
export async function resolveInsiderExit(ctx: ResolverContext): Promise<Resolution> {
  const cluster = new Set(ctx.clusterWallets.map((a) => a.toLowerCase()));
  if (cluster.size === 0) {
    return unresolvable('no cluster wallets recorded for this launch');
  }

  const fromBlock = ctx.launchBlock;
  const toBlock = ctx.horizonBlock;
  const coverage = newCoverage(fromBlock, toBlock, ctx.maxRange);
  const clusterTopics = [...cluster].map((a) => addressToTopic(a));

  // from ∈ cluster (topic 1) and to ∈ cluster (topic 2), batched so a large
  // cluster doesn't trip the RPC's per-request topic-value cap.
  const [outLogs, inLogs] = await Promise.all([
    withRetry(
      () =>
        getLogsByTopicValues(ctx.client, {
          address: ctx.token as Hex,
          topic0: TRANSFER_TOPIC0 as Hex,
          valuePosition: 1,
          values: clusterTopics,
          fromBlock,
          toBlock,
          maxRange: ctx.maxRange,
        }),
      { tries: 4, delayMs: 2000 },
    ),
    withRetry(
      () =>
        getLogsByTopicValues(ctx.client, {
          address: ctx.token as Hex,
          topic0: TRANSFER_TOPIC0 as Hex,
          valuePosition: 2,
          values: clusterTopics,
          fromBlock,
          toBlock,
          maxRange: ctx.maxRange,
        }),
      { tries: 4, delayMs: 2000 },
    ),
  ]);
  coverage.callCount = 2 * coverage.callCount * Math.ceil(clusterTopics.length / 4);

  if (outLogs.length >= MAX_INSIDER_LOGS || inLogs.length >= MAX_INSIDER_LOGS) {
    coverage.gaps.push(
      `transfer log cap hit (out=${outLogs.length}, in=${inLogs.length}); cannot trust a partial balance replay`,
    );
    return unresolvable('too many cluster transfers to replay reliably', coverage);
  }

  const poolSinks = new Set(
    [ctx.pool.poolManager, ctx.pool.poolAddress]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  );
  coverage.notes.push('sells counted only when the recipient is the pool address');

  type Ev = { block: bigint; logIndex: number; from: string; to: string; value: bigint };
  const seen = new Set<string>();
  const events: Ev[] = [];
  for (const log of [...outLogs, ...inLogs]) {
    const key = `${BigInt(log.blockNumber)}-${Number(log.logIndex)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = log.topics[1] ? topicToAddress(log.topics[1]) : '';
    const to = log.topics[2] ? topicToAddress(log.topics[2]) : '';
    if (!from || !to) continue;
    events.push({
      block: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex),
      from,
      to,
      value: transferValue(log.data),
    });
  }
  events.sort((a, b) => {
    if (a.block !== b.block) return a.block < b.block ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  let agg = 0n;
  let peak = 0n;
  let soldToPool = 0n;
  let boughtFromPool = 0n;
  const sellTxs: string[] = [];
  for (const e of events) {
    const fromCluster = cluster.has(e.from);
    const toCluster = cluster.has(e.to);
    if (fromCluster) agg -= e.value;
    if (toCluster) agg += e.value;
    if (agg > peak) peak = agg;
    if (fromCluster && poolSinks.has(e.to)) {
      soldToPool += e.value;
      if (sellTxs.length < 20) {
        // logs don't carry txHash in RpcLog here; record block+index for lookup
        sellTxs.push(`block ${e.block} log ${e.logIndex}`);
      }
    }
    if (toCluster && poolSinks.has(e.from)) boughtFromPool += e.value;
  }

  if (peak === 0n) {
    return resolved(false, {
      clusterSize: cluster.size,
      peakHoldings: '0',
      note: 'cluster never held tokens in the window',
    }, coverage);
  }

  const netSold = soldToPool - boughtFromPool;
  const ratio = Number((netSold * 10_000n) / peak) / 10_000;
  return resolved(netSold * 2n >= peak, {
    clusterSize: cluster.size,
    peakHoldings: peak.toString(),
    soldToPool: soldToPool.toString(),
    boughtFromPool: boughtFromPool.toString(),
    netSoldToPool: netSold.toString(),
    ratioOfPeak: ratio,
    sells: sellTxs,
    transfersReplayed: events.length,
  }, coverage);
}
