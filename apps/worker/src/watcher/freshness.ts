import type { Address, PublicClient } from 'viem';

/**
 * A fresh Uniswap pool is not the same thing as a new token launch: someone can
 * pool two assets that have both existed for months (a tokenized-stock / USDG
 * pair getting a new fee tier). Before indexing a detected pool as a launch,
 * check whether its "token" side already had code well before the pool — if so,
 * it is the quote side, not the launch.
 *
 * Checked via `eth_getCode` at an earlier block, not Blockscout: Blockscout is
 * behind Cloudflare and 403s a plain server-side fetch (confirmed), so it can't
 * be a runtime dependency even though spec §3.1 allows it. Chain 4663's RPC
 * keeps full historical state (`eth_getCode` resolves across a 54M-block gap).
 *
 * M4d / checkpoint §8.6: the window is 24h, not 1h. A token deployed in the
 * morning and pooled in the afternoon is still a launch; a months-old tokenized
 * stock is not.
 */
export const FRESH_LAUNCH_WINDOW_BLOCKS = 864_000n; // ~24h at chain 4663's ~0.1s blocks

export type FreshnessReason = 'fresh' | 'preexisting' | 'inconclusive';

export interface FreshnessCheck {
  isFreshLaunch: boolean;
  reason: FreshnessReason;
  checkedAtBlock: bigint;
}

export type FreshnessClient = Pick<PublicClient, 'getCode'>;

async function hasCodeAt(
  client: FreshnessClient,
  address: Address,
  blockNumber: bigint,
): Promise<boolean> {
  const code = await client.getCode({ address, blockNumber });
  return Boolean(code) && code !== '0x';
}

export async function checkTokenFreshness(
  client: FreshnessClient,
  tokenAddress: Address,
  poolBlockNumber: bigint,
  windowBlocks: bigint = FRESH_LAUNCH_WINDOW_BLOCKS,
): Promise<FreshnessCheck> {
  const checkedAtBlock = poolBlockNumber > windowBlocks ? poolBlockNumber - windowBlocks : 0n;
  try {
    const hadCodeAlready = await hasCodeAt(client, tokenAddress, checkedAtBlock);
    return {
      isFreshLaunch: !hadCodeAlready,
      reason: hadCodeAlready ? 'preexisting' : 'fresh',
      checkedAtBlock,
    };
  } catch {
    // RPC couldn't answer for this historical block — don't block indexing on it
    return { isFreshLaunch: true, reason: 'inconclusive', checkedAtBlock };
  }
}

export interface TokenAgeResult {
  /** token code age at pool creation, seconds; null when older than the window */
  ageSec: number | null;
  /** approximate deployment block (upper bound); null when older than the window */
  deployBlockApprox: bigint | null;
  iters: number;
}

/**
 * Age of the token's code at pool creation, by bounded binary search for the
 * earliest block in [poolBlock - windowBlocks, poolBlock] that has code. Archive
 * `eth_getCode` is 1-6s per call on ordofi, so this runs on the T+10m job / the
 * backfill, never the poller. Day-ish precision is enough (checkpoint §8.6).
 */
export async function computeTokenAgeAtPool(
  client: FreshnessClient,
  tokenAddress: Address,
  poolBlockNumber: bigint,
  approxBlockSeconds: number,
  windowBlocks: bigint = FRESH_LAUNCH_WINDOW_BLOCKS,
  maxIters = 12,
): Promise<TokenAgeResult> {
  let lo = poolBlockNumber > windowBlocks ? poolBlockNumber - windowBlocks : 0n;
  const hi0 = poolBlockNumber;
  let iters = 0;

  try {
    if (await hasCodeAt(client, tokenAddress, lo)) {
      return { ageSec: null, deployBlockApprox: null, iters: 1 };
    }
    if (!(await hasCodeAt(client, tokenAddress, hi0))) {
      // no code even at pool block — shouldn't happen for a real token; bail
      return { ageSec: 0, deployBlockApprox: hi0, iters: 2 };
    }
    iters = 2;
    let hi = hi0;
    while (hi - lo > 1n && iters < maxIters) {
      const mid = lo + (hi - lo) / 2n;
      iters++;
      if (await hasCodeAt(client, tokenAddress, mid)) hi = mid;
      else lo = mid;
    }
    const deploy = hi; // first block with code (upper bound)
    const ageBlocks = poolBlockNumber > deploy ? poolBlockNumber - deploy : 0n;
    return {
      ageSec: Math.round(Number(ageBlocks) * approxBlockSeconds),
      deployBlockApprox: deploy,
      iters,
    };
  } catch {
    return { ageSec: null, deployBlockApprox: null, iters };
  }
}
