import type { PublicClient } from 'viem';

/**
 * Map a wall-clock time to the last block mined at or before it. Bounded binary
 * search over block timestamps; results memoised per (chainId, rounded second)
 * because every outcome batch for one report shares an anchor time and its
 * horizons repeat across launches.
 */
export type BlockTimeClient = Pick<PublicClient, 'getBlock' | 'getBlockNumber'>;

const cache = new Map<string, bigint>();

export interface BlockAtTimeOptions {
  chainId?: number;
  /** cap on search iterations (each = 1 getBlock call) */
  maxIters?: number;
  /** treat the chain as starting no earlier than this block */
  minBlock?: bigint;
}

export async function blockAtTime(
  client: BlockTimeClient,
  when: Date,
  opts: BlockAtTimeOptions = {},
): Promise<bigint> {
  const targetSec = BigInt(Math.floor(when.getTime() / 1000));
  const key = `${opts.chainId ?? 4663}:${targetSec}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const maxIters = opts.maxIters ?? 18;
  let lo = opts.minBlock ?? 1n;
  let hi = await client.getBlockNumber();

  const headTs = (await client.getBlock({ blockNumber: hi })).timestamp;
  if (targetSec >= headTs) {
    cache.set(key, hi);
    return hi;
  }
  const loTs = (await client.getBlock({ blockNumber: lo })).timestamp;
  if (targetSec <= loTs) {
    cache.set(key, lo);
    return lo;
  }

  let answer = lo;
  for (let i = 0; i < maxIters && lo <= hi; i++) {
    const mid = lo + (hi - lo) / 2n;
    const ts = (await client.getBlock({ blockNumber: mid })).timestamp;
    if (ts <= targetSec) {
      answer = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  cache.set(key, answer);
  return answer;
}

/** test hook */
export function clearBlockTimeCache(): void {
  cache.clear();
}
