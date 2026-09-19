import { getLogsChunked } from '@launch-auditor/chain';
import { erc20Abi, type Hex, type PublicClient } from 'viem';
import type { LogClient } from './detect';
import { TRANSFER_TOPIC0, ZERO_ADDRESS, topicToAddress, transferValue } from './erc20';

// Features 4 & 5 (spec §3.3.4-5) at T+10m: cluster_supply_pct, top10_noncreator_pct.
// Balances reconstructed from the token's Transfer logs up to the T+10m block —
// RPC-only (Blockscout's holder list is 403 from the server).

/** Same rationale as MAX_T10_LOGS: a misclassified quote asset floods this. */
export const MAX_HOLDER_LOGS = 20_000;

export interface HolderStats {
  clusterSupplyPct: number | null;
  top10NoncreatorPct: number | null;
  totalSupply: bigint | null;
  holderCount: number | null;
}

export interface HolderParams {
  logClient: LogClient;
  readClient: Pick<PublicClient, 'readContract'>;
  token: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  maxRange: number;
  creator: string;
  /** distinct cluster addresses (lowercased) */
  cluster: Set<string>;
  /** pool / PoolManager — excluded from "holders" */
  liquiditySource: string;
}

/** net token balances from Transfer logs in [fromBlock, toBlock]. */
export async function reconstructBalances(
  client: LogClient,
  token: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<Map<string, bigint> | null> {
  const logs = await getLogsChunked(client, {
    address: token,
    topics: [TRANSFER_TOPIC0 as Hex],
    fromBlock,
    toBlock,
    maxRange,
  });
  if (logs.length > MAX_HOLDER_LOGS) return null;

  const bal = new Map<string, bigint>();
  const bump = (addr: string, delta: bigint): void => {
    if (addr === ZERO_ADDRESS) return;
    bal.set(addr, (bal.get(addr) ?? 0n) + delta);
  };
  for (const log of logs) {
    const from = log.topics[1] ? topicToAddress(log.topics[1]) : null;
    const to = log.topics[2] ? topicToAddress(log.topics[2]) : null;
    if (!from || !to) continue;
    const value = transferValue(log.data);
    bump(from, -value);
    bump(to, value);
  }
  return bal;
}

export async function computeHolderStats(p: HolderParams): Promise<HolderStats> {
  const empty: HolderStats = {
    clusterSupplyPct: null,
    top10NoncreatorPct: null,
    totalSupply: null,
    holderCount: null,
  };
  try {
    const balances = await reconstructBalances(
      p.logClient,
      p.token,
      p.fromBlock,
      p.toBlock,
      p.maxRange,
    );
    if (!balances) return empty;

    const totalSupply = (await p.readClient.readContract({
      address: p.token,
      abi: erc20Abi,
      functionName: 'totalSupply',
      blockNumber: p.toBlock,
    })) as bigint;
    if (totalSupply <= 0n) return { ...empty, totalSupply };

    const creator = p.creator.toLowerCase();
    const liq = p.liquiditySource.toLowerCase();

    let clusterBal = 0n;
    const holders: { addr: string; bal: bigint }[] = [];
    for (const [addr, bal] of balances) {
      if (bal <= 0n) continue;
      if (p.cluster.has(addr)) clusterBal += bal;
      if (addr !== creator && addr !== liq) holders.push({ addr, bal });
    }
    holders.sort((a, b) => (a.bal < b.bal ? 1 : a.bal > b.bal ? -1 : 0));
    const top10 = holders.slice(0, 10).reduce((s, h) => s + h.bal, 0n);

    // percent to 12 decimal places without Number()-ing the raw supply
    // (token supplies routinely exceed 2^53): part/total * 100
    const pct = (part: bigint): number =>
      Number((part * 100n * 10n ** 12n) / totalSupply) / 1e12;
    return {
      clusterSupplyPct: pct(clusterBal),
      top10NoncreatorPct: pct(top10),
      totalSupply,
      holderCount: holders.length,
    };
  } catch {
    return empty;
  }
}
