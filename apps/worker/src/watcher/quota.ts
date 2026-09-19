import { prisma } from '@launch-auditor/db';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure rule: the Nth launch is over quota once N-1 already exist in the window. */
export function isOverQuota(priorCountInWindow: number, limit: number): boolean {
  return priorCountInWindow >= limit;
}

/**
 * Spec §3.1: after `limit` launches by one creator in 24h, further launches are
 * still indexed but flagged `quotaExceeded` and not scored.
 */
export async function creatorQuotaExceeded(
  chainId: number,
  creator: string,
  at: Date,
  limit: number,
): Promise<boolean> {
  const since = new Date(at.getTime() - DAY_MS);
  const priorCount = await prisma.launch.count({
    where: { chainId, creatorAddress: creator, launchAt: { gte: since, lte: at } },
  });
  return isOverQuota(priorCount, limit);
}
