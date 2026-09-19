import { prisma } from '@launch-auditor/db';
import type { Hex, PublicClient } from 'viem';

// Feature 3 (spec §3.3.3): creator_age_days, creator_prior_launches,
// creator_prior_insider_exit_rate. Computed on the index lane (immediately).

export interface CreatorContext {
  creatorAgeDays: number | null;
  creatorPriorLaunches: number | null;
  creatorPriorInsiderExitRate: number | null;
}

export type NonceClient = Pick<PublicClient, 'getTransactionCount'>;

/**
 * Block at which the creator first sent a transaction, found by binary search on
 * `eth_getTransactionCount` (nonce). RPC-only — Blockscout's address-age field is
 * 403 from the server. Historical `getTransactionCount` on this RPC is 1-6s per
 * call, so the search is capped: `maxIters` of 8 leaves ~200k-block (sub-day)
 * precision, which is plenty for a feature measured in days. Returns null if the
 * creator had no prior transactions (e.g. the launch was relayed for them).
 */
export async function firstTxBlock(
  client: NonceClient,
  creator: Hex,
  launchBlock: bigint,
  maxIters = 8,
): Promise<bigint | null> {
  const nonceAtLaunch = await client.getTransactionCount({
    address: creator,
    blockNumber: launchBlock,
  });
  if (nonceAtLaunch === 0) return null;

  let lo = 0n;
  let hi = launchBlock; // smallest block confirmed to have nonce >= 1
  for (let i = 0; i < maxIters && lo < hi; i += 1) {
    const mid = (lo + hi) / 2n;
    const nonce = await client.getTransactionCount({ address: creator, blockNumber: mid });
    if (nonce >= 1) hi = mid;
    else lo = mid + 1n;
  }
  // hi is an upper bound on the true first-tx block, so age computed from it is a
  // conservative under-estimate — a new creator never looks more established.
  return hi;
}

export interface CreatorContextParams {
  client: NonceClient;
  chainId: number;
  creator: Hex;
  launchBlock: bigint;
  /** exclude this launch itself from the prior-launch count (when it already exists) */
  launchId?: string;
  approxBlockSeconds: number;
  /**
   * If the launch already has a `creator_age_days`, pass it to skip the slow
   * (1-6s/call) nonce binary search — age doesn't change.
   */
  existingAgeDays?: number | null;
}

export async function computeCreatorContext(
  p: CreatorContextParams,
): Promise<CreatorContext> {
  let creatorAgeDays: number | null = p.existingAgeDays ?? null;
  if (creatorAgeDays === null) {
    try {
      const first = await firstTxBlock(p.client, p.creator, p.launchBlock);
      if (first !== null) {
        const ageBlocks = p.launchBlock > first ? p.launchBlock - first : 0n;
        creatorAgeDays = (Number(ageBlocks) * p.approxBlockSeconds) / 86_400;
      }
    } catch {
      // leave null — a later re-run retries
    }
  }

  const priorLaunches = await prisma.launch.findMany({
    where: {
      chainId: p.chainId,
      creatorAddress: p.creator.toLowerCase(),
      launchBlock: { lt: p.launchBlock },
      ...(p.launchId ? { id: { not: p.launchId } } : {}),
    },
    select: { id: true },
  });

  let creatorPriorInsiderExitRate: number | null = null;
  if (priorLaunches.length > 0) {
    const ids = priorLaunches.map((l) => l.id);
    const resolved = await prisma.outcome.findMany({
      where: { launchId: { in: ids }, label: 'INSIDER_EXIT', status: 'RESOLVED' },
      select: { launchId: true, value: true },
    });
    if (resolved.length > 0) {
      const byLaunch = new Map<string, boolean>();
      for (const o of resolved) {
        if (o.launchId) byLaunch.set(o.launchId, o.value ?? false);
      }
      const positives = [...byLaunch.values()].filter(Boolean).length;
      creatorPriorInsiderExitRate = positives / byLaunch.size;
    }
  }

  return {
    creatorAgeDays,
    creatorPriorLaunches: priorLaunches.length,
    creatorPriorInsiderExitRate,
  };
}
