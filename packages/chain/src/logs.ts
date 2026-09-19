import { numberToHex, type Address, type Hex, type PublicClient } from 'viem';

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed: boolean;
}

export interface ChunkedLogsParams {
  address?: Address | Address[];
  topics?: (Hex | Hex[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
  /** Max blocks per eth_getLogs call (RPC range limit; 2000 for ordofi). */
  maxRange: number;
}

/**
 * eth_getLogs split into <= maxRange-block windows so it stays under the RPC's
 * range limit. Returns raw RPC logs in block order.
 */
export async function getLogsChunked(
  client: Pick<PublicClient, 'request'>,
  params: ChunkedLogsParams,
): Promise<RpcLog[]> {
  const { address, topics, fromBlock, toBlock, maxRange } = params;
  if (maxRange < 1) throw new Error('maxRange must be >= 1');

  const out: RpcLog[] = [];
  const step = BigInt(maxRange);
  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = start + step - 1n < toBlock ? start + step - 1n : toBlock;
    const batch = (await client.request({
      method: 'eth_getLogs',
      params: [
        {
          address,
          topics,
          fromBlock: numberToHex(start),
          toBlock: numberToHex(end),
        },
      ],
    })) as unknown as RpcLog[];
    out.push(...batch);
  }
  return out;
}

export const hexToBigInt = (h: Hex): bigint => BigInt(h);

/**
 * eth_getLogs with an OR-list of values in one indexed topic slot, split into
 * batches so it stays under the RPC's per-request topic-count cap (blockmachine
 * rejects a large `topics[n]` array with "exceed max topics"). Results merged,
 * de-duped by (blockNumber, logIndex), block-ordered.
 */
export async function getLogsByTopicValues(
  client: Pick<PublicClient, 'request'>,
  params: {
    address?: Address | Address[];
    topic0: Hex;
    /** which indexed slot the values go in: 1, 2 or 3 */
    valuePosition: 1 | 2 | 3;
    values: Hex[];
    fromBlock: bigint;
    toBlock: bigint;
    maxRange: number;
    /** max OR values per request (default 4 — conservative for blockmachine) */
    maxTopicValues?: number;
  },
): Promise<RpcLog[]> {
  const cap = params.maxTopicValues ?? 4;
  const batches: Hex[][] = [];
  for (let i = 0; i < params.values.length; i += cap) {
    batches.push(params.values.slice(i, i + cap));
  }
  if (batches.length === 0) return [];

  const seen = new Set<string>();
  const out: RpcLog[] = [];
  for (const batch of batches) {
    const topics: (Hex | Hex[] | null)[] = [params.topic0, null, null];
    topics[params.valuePosition] = batch;
    const logs = await getLogsChunked(client, {
      address: params.address,
      topics: topics.slice(0, params.valuePosition + 1),
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      maxRange: params.maxRange,
    });
    for (const l of logs) {
      const bn = l.blockNumber ? BigInt(l.blockNumber) : 0n;
      const li = l.logIndex !== undefined ? Number(l.logIndex) : -1;
      const k = li >= 0 ? `${bn}-${li}` : `${bn}-${l.transactionHash ?? ''}-${out.length}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
  }
  out.sort((a, b) => {
    const ba = a.blockNumber ? BigInt(a.blockNumber) : 0n;
    const bb = b.blockNumber ? BigInt(b.blockNumber) : 0n;
    if (ba !== bb) return ba < bb ? -1 : 1;
    return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
  });
  return out;
}
