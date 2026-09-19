/**
 * Bind {@link DeepdiveContext} to the live M1–M4 providers for one `Launch`.
 * This is integration glue (RPC-logs history, cluster, price series, holders,
 * ScanHood) — the agent tolerates any single method throwing (it becomes a
 * coverage limitation), so bindings are best-effort. `deepdive/run.ts`'s
 * orchestration is what carries the unit tests.
 */
import {
  getGetLogsMaxRange,
  getLogsChunked,
  poolCreationSources,
  type ChainConfig,
} from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import type { Hex, PublicClient } from 'viem';
import { RpcLogsAddressHistory } from '../history/rpc-logs';
import type { TokenTransfer } from '../history/provider';
import { buildPriceSeries, type PoolRef } from '../outcomes/series';
import { fetchScanHoodQuote, fetchScanHoodScan, mapScanHood } from '../scanners/scanhood';
import { buildCreatorCluster } from '../watcher/cluster';
import { TRANSFER_TOPIC0, topicToAddress, transferValue, ZERO_ADDRESS } from '../watcher/erc20';
import { computeHolderStats } from '../watcher/holders';
import { resolveContractCode } from './contract-code';
import type { DeepdiveContext } from './tools';

type Launch = NonNullable<Awaited<ReturnType<typeof prisma.launch.findUnique>>>;

export interface DeepdiveContextClients {
  rpc: PublicClient;
  scanhoodBaseUrl: string;
}

export function buildDeepdiveContext(
  launch: Launch,
  clients: DeepdiveContextClients,
  cfg: ChainConfig,
): DeepdiveContext {
  const { rpc } = clients;
  const maxRange = getGetLogsMaxRange(launch.chainId);
  const history = new RpcLogsAddressHistory(rpc, maxRange);
  const v4PoolManager = poolCreationSources(launch.chainId).v4PoolManager;
  const liquiditySource = launch.poolAddress ?? v4PoolManager;
  const blocksIn10m = BigInt(Math.round((10 * 60) / cfg.approxBlockSeconds));
  const token = launch.tokenAddress.toLowerCase();
  const quote = (launch.quoteAddress ?? '').toLowerCase();

  const poolRef: PoolRef = {
    poolKind: (launch.poolKind as 'v2' | 'v3' | 'v4' | null) ?? 'v4',
    poolManager: v4PoolManager,
    poolAddress: launch.poolAddress,
    poolId: launch.poolId,
    tokenIsCurrency0: quote ? token < quote : true,
  };

  return {
    addressTokenActivity: (p) =>
      history.tokenActivity(p.address, { token: p.token, fromBlock: p.fromBlock, toBlock: p.toBlock }),

    tokenTransfers: async (p) => {
      const logs = await getLogsChunked(rpc, {
        address: p.token as Hex,
        topics: [TRANSFER_TOPIC0],
        fromBlock: p.fromBlock,
        toBlock: p.toBlock,
        maxRange,
      });
      const out: TokenTransfer[] = logs.map((l) => ({
        token,
        from: topicToAddress(l.topics[1] ?? ZERO_ADDRESS),
        to: topicToAddress(l.topics[2] ?? ZERO_ADDRESS),
        value: transferValue(l.data),
        block: BigInt(l.blockNumber),
        logIndex: Number(l.logIndex),
        txHash: l.transactionHash,
      }));
      return out.sort((a, b) =>
        a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex,
      );
    },

    clusterExpand: (p) =>
      buildCreatorCluster({
        client: rpc,
        token: launch.tokenAddress as Hex,
        creator: p.creator,
        liquiditySource,
        launchBlock: launch.launchBlock,
        windowBlocks: blocksIn10m,
        maxRange,
      }),

    priceSeries: (p) =>
      buildPriceSeries(rpc, { ...poolRef, poolId: p.poolId }, p.fromBlock, p.toBlock, maxRange),

    holderSnapshot: async (p) => {
      const members = await prisma.clusterMember.findMany({
        where: { launchId: launch.id },
        select: { address: true },
      });
      return computeHolderStats({
        logClient: rpc,
        readClient: rpc,
        token: p.token as Hex,
        fromBlock: launch.launchBlock,
        toBlock: p.block,
        maxRange,
        creator: launch.creatorAddress,
        cluster: new Set(members.map((m) => m.address.toLowerCase())),
        liquiditySource,
      });
    },

    contractCode: (p) => resolveContractCode(rpc, p.address, p.block),

    scanhoodScan: async (p) => {
      const r = await fetchScanHoodScan(p.token, { baseUrl: clients.scanhoodBaseUrl });
      return r.ok ? mapScanHood(r.data) : null;
    },

    scanhoodQuote: async (p) => {
      const r = await fetchScanHoodQuote(p.token, 'sell', p.sizeUsdg, { baseUrl: clients.scanhoodBaseUrl });
      return r.ok ? r.data : null;
    },
  };
}
