import {
  POOL_EVENT_TOPIC0,
  decodePoolCreation,
  getLogsChunked,
  poolCreationSources,
  type PoolCreation,
  type RpcLog,
} from '@launch-auditor/chain';
import type { Hex, PublicClient } from 'viem';

export interface DetectedPool {
  poolCreation: PoolCreation;
  log: RpcLog;
  blockNumber: bigint;
  txHash: string;
}

export type LogClient = Pick<PublicClient, 'request'>;

/**
 * Fetch every Uniswap v2/v3/v4 pool-creation log in [fromBlock, toBlock] on the
 * configured chain and decode it. This is the source-agnostic net: a pool is a
 * pool whether a launchpad made it or not.
 */
export async function detectPools(
  client: LogClient,
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<DetectedPool[]> {
  const src = poolCreationSources(chainId);
  const addresses = [
    src.v2Factory,
    ...src.v3Factories,
    src.v4PoolManager,
  ] as Hex[];
  const topics: Hex[][] = [
    [
      POOL_EVENT_TOPIC0.v2PairCreated,
      POOL_EVENT_TOPIC0.v3PoolCreated,
      POOL_EVENT_TOPIC0.v4Initialize,
    ],
  ];

  const logs = await getLogsChunked(client, {
    address: addresses,
    topics,
    fromBlock,
    toBlock,
    maxRange,
  });

  const out: DetectedPool[] = [];
  for (const log of logs) {
    const poolCreation = decodePoolCreation(log);
    if (!poolCreation) continue;
    out.push({
      poolCreation,
      log,
      blockNumber: BigInt(log.blockNumber),
      txHash: log.transactionHash,
    });
  }
  return out;
}
