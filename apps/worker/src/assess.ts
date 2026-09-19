/**
 * M7 — consumer for `POST /v1/assess/{token}` (spec §9): an on-demand
 * det_v0 / heuristic_v1 report for an already-indexed token, at any age.
 *
 * Scope cut, stated plainly: the spec also asks for "daily scheduled
 * re-scores for 7 days." That's the recurring, event-aware re-scoring layer
 * (age-aware `ageHours` / `holderCountTrend` / `clusterBalanceDeltaPct` /
 * `liquidityDeltaPct` inputs already have columns on `Report` but nothing
 * computes them) — this is v0.3 Watch (spec §10.1), not built here. This
 * consumer produces one immediate on-demand report and stops.
 */
import { prisma } from '@launch-auditor/db';
import type { PublicClient } from 'viem';
import { Worker } from 'bullmq';
import { loadEnv } from './env';
import { QUEUE_NAMES, parseRedisUrl } from './queues';
import { buildLaunchReports, persistLaunchReports } from './report';

export interface AssessJob {
  tokenAddress: string;
}

export interface AssessResult {
  ran: boolean;
  reason?: string;
  reportHashes?: string[];
}

export async function runAssess(client: PublicClient, tokenAddress: string): Promise<AssessResult> {
  const env = loadEnv();
  const launch = await prisma.launch.findUnique({
    where: { chainId_tokenAddress: { chainId: env.chainId, tokenAddress: tokenAddress.toLowerCase() } },
    select: { id: true },
  });
  if (!launch) {
    return { ran: false, reason: 'token is not an indexed launch on this chain — nothing to assess' };
  }
  const drafts = await buildLaunchReports(client, launch.id, 'on_demand');
  if (drafts.length === 0) return { ran: false, reason: 'report assembly produced nothing (missing features?)' };
  await persistLaunchReports(drafts);
  return { ran: true, reportHashes: drafts.map((d) => d.reportHash) };
}

export function startAssessWorker(client: PublicClient): Worker {
  const connection = parseRedisUrl(loadEnv().redisUrl);
  return new Worker(
    QUEUE_NAMES.assess,
    async (job) => {
      const d = job.data as AssessJob;
      return runAssess(client, d.tokenAddress);
    },
    { connection, concurrency: 2 },
  );
}
