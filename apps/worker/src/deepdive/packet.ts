/**
 * The frozen target packet (spec §8.2, from the `evm-token-due-diligence` skill):
 * chain id from RPC, exact address, a block pin with hash + UTC timestamp,
 * runtime code hash, proxy/implementation resolution, candidate pools. Everything
 * the deep-dive reasons about is pinned to `reportBlock` so the run is reproducible.
 */
import type { Hex } from 'viem';
import { resolveContractCode, type CodeClient, type ContractCode } from './contract-code';

export interface CandidatePool {
  kind: 'v2' | 'v3' | 'v4';
  poolAddress: string | null;
  poolId: string | null;
  feeHundredthsBip: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  /** true when fee ≥ 10% — decoy / token-vs-token pool (M4 primary-pool selection) */
  feeSuspect: boolean;
}

/** The launch fields the packet is built from (a subset of the `Launch` row). */
export interface DeepdiveTarget {
  chainId: number;
  tokenAddress: string;
  quoteAddress: string | null;
  creatorAddress: string;
  launchBlock: bigint;
  launchTxHash: string;
  launchAt: Date | null;
  source: string;
  pools: CandidatePool[];
}

export interface BlockPin {
  number: string;
  hash: string;
  timestampUtc: string;
}

export interface TargetPacket {
  chainId: number;
  /** chain id the RPC actually reports — must equal `chainId` */
  rpcChainId: number;
  chainIdMatches: boolean;
  tokenAddress: string;
  quoteAddress: string | null;
  creatorAddress: string;
  source: string;
  reportBlock: BlockPin;
  launch: { block: string; txHash: string; at: string | null };
  code: ContractCode;
  /** implementation code, resolved when `code.isProxy` */
  implementationCode: ContractCode | null;
  pools: CandidatePool[];
  builtAtUtc: string;
}

export interface PacketClient extends CodeClient {
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber?: bigint; blockTag?: 'latest' }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }>;
}

/**
 * Build the packet at `reportBlock` (default: current head). All reads are
 * pinned to that block number.
 */
export async function buildTargetPacket(
  client: PacketClient,
  target: DeepdiveTarget,
  reportBlock?: bigint,
): Promise<TargetPacket> {
  const [rpcChainId, head] = await Promise.all([
    client.getChainId(),
    reportBlock === undefined
      ? client.getBlock({ blockTag: 'latest' })
      : client.getBlock({ blockNumber: reportBlock }),
  ]);
  const blockNumber = reportBlock ?? head.number ?? 0n;

  const code = await resolveContractCode(client, target.tokenAddress, blockNumber);
  const implementationCode =
    code.isProxy && code.implementation
      ? await resolveContractCode(client, code.implementation, blockNumber)
      : null;

  return {
    chainId: target.chainId,
    rpcChainId,
    chainIdMatches: rpcChainId === target.chainId,
    tokenAddress: target.tokenAddress.toLowerCase(),
    quoteAddress: target.quoteAddress ? target.quoteAddress.toLowerCase() : null,
    creatorAddress: target.creatorAddress.toLowerCase(),
    source: target.source,
    reportBlock: {
      number: blockNumber.toString(),
      hash: head.hash ?? '0x',
      timestampUtc: new Date(Number(head.timestamp) * 1000).toISOString(),
    },
    launch: {
      block: target.launchBlock.toString(),
      txHash: target.launchTxHash,
      at: target.launchAt ? target.launchAt.toISOString() : null,
    },
    code,
    implementationCode,
    pools: target.pools,
    builtAtUtc: new Date().toISOString(),
  };
}
