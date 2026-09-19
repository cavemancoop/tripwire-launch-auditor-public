import { attributeSource, getChainConfig } from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import type { Hex, PublicClient } from 'viem';
import { getQueues, T10_DELAY_MS } from '../queues';
import { classifyPair } from './classify';
import type { DetectedPool } from './detect';
import { computeIndexFeatures } from './features';
import { checkTokenFreshness } from './freshness';
import { computeHookFeatures } from './hooks';
import { isFeeSuspect } from './primary-pool';
import { creatorQuotaExceeded } from './quota';
import { withRetry } from './retry';

export interface IngestDeps {
  client: PublicClient;
  chainId: number;
  quotaPerCreator24h: number;
  /** override the T+10m enqueue (tests / backfill) */
  enqueueT10?: (launchId: string) => Promise<void>;
  /** mark the row retrospective (spec §7 backfill) */
  retrospective?: boolean;
  /** skip pools where the token/quote split couldn't be confidently determined
   *  (token-vs-token pools, of which chain 4663 has many) — used for a clean
   *  base-rate backfill; the live poller indexes everything */
  confidentOnly?: boolean;
}

/** Address that tokens leave on a buy: v4 PoolManager, else the pool contract. */
export function liquiditySource(chainId: number, dp: DetectedPool): Hex {
  if (dp.poolCreation.poolKind === 'v4') {
    return getChainConfig(chainId).uniswap.v4PoolManager.address as Hex;
  }
  return dp.poolCreation.poolAddress as Hex;
}

/**
 * Persist one detected pool as a `launches` row (index lane): attribute the
 * launchpad, resolve the creator, run the per-creator quota, compute the
 * immediate index-lane features, and enqueue the T+10m job.
 * Returns the launch id, or null if it was already indexed.
 */
export async function ingestPool(
  dp: DetectedPool,
  deps: IngestDeps,
): Promise<string | null> {
  const { client, chainId, quotaPerCreator24h } = deps;
  const { poolCreation: pc, txHash, blockNumber } = dp;

  let { token, quote, confident } = classifyPair(chainId, pc.token0, pc.token1);

  // When neither side matched a configured quote asset, freshness disambiguates:
  // a side whose code predates the pool by >24h is the quote side (checkpoint
  // §8.6 — LONG pairs new tokens against months-old tokenized stocks, so picking
  // the stock as "the token" would wrongly reject the whole pool).
  let f0: Awaited<ReturnType<typeof checkTokenFreshness>> | undefined;
  let f1: Awaited<ReturnType<typeof checkTokenFreshness>> | undefined;
  if (!confident) {
    [f0, f1] = await Promise.all([
      checkTokenFreshness(client, pc.token0 as Hex, blockNumber),
      checkTokenFreshness(client, pc.token1 as Hex, blockNumber),
    ]);
    if (f0.isFreshLaunch && !f1.isFreshLaunch) {
      token = pc.token0;
      quote = pc.token1;
      confident = true;
    } else if (f1.isFreshLaunch && !f0.isFreshLaunch) {
      token = pc.token1;
      quote = pc.token0;
      confident = true;
    }
  }

  if (deps.confidentOnly && !confident) return null; // skip token-vs-token pools

  const existing = await prisma.launch.findUnique({
    where: { chainId_tokenAddress: { chainId, tokenAddress: token.toLowerCase() } },
  });
  if (existing) return null;

  // A new pool isn't the same thing as a new token launch: two long-established
  // assets (e.g. a tokenized stock / USDG pair) can get a fresh pool. Only index
  // this as a launch if the token side was actually just deployed.
  const freshness =
    token === pc.token0 && f0
      ? f0
      : token === pc.token1 && f1
        ? f1
        : await checkTokenFreshness(client, token as Hex, blockNumber);
  if (!freshness.isFreshLaunch) {
    // eslint-disable-next-line no-console
    console.log(
      `[watcher] skipping ${token} at block ${blockNumber}: not a new-token launch ` +
        `(had code by block ${freshness.checkedAtBlock}, tx ${txHash})`,
    );
    return null;
  }

  // A just-seen tx/block can read back as "not found" from a lagging RPC node
  // (load balancing) or a shallow reorg — retry with backoff before giving up.
  const [tx, receipt, block] = await withRetry(() =>
    Promise.all([
      client.getTransaction({ hash: txHash as Hex }),
      client.getTransactionReceipt({ hash: txHash as Hex }),
      client.getBlock({ blockNumber }),
    ]),
  );

  const creator = tx.from.toLowerCase();
  const touched = new Set<string>([
    tx.to ?? '',
    ...receipt.logs.map((l) => l.address),
  ]);
  const attribution = attributeSource(chainId, touched);

  const launchAt = new Date(Number(block.timestamp) * 1000);
  const quotaExceeded = await creatorQuotaExceeded(
    chainId,
    creator,
    launchAt,
    quotaPerCreator24h,
  );

  const liqSource = liquiditySource(chainId, dp);
  const idx = await computeIndexFeatures(client, token as Hex, txHash as Hex, liqSource);

  const lc = (s: string | null | undefined): string | undefined =>
    s ? s.toLowerCase() : undefined;

  const launch = await prisma.launch.create({
    data: {
      chainId,
      source: attribution.source,
      sourceConfidence: attribution.sourceConfidence,
      lpLockedByConstruction: attribution.lpLockedByConstruction,
      tokenAddress: token.toLowerCase(),
      quoteAddress: lc(quote),
      poolKind: pc.poolKind,
      poolAddress: lc(pc.poolAddress),
      poolId: lc(pc.poolId),
      poolFee: pc.fee ?? undefined,
      poolTickSpacing: pc.tickSpacing ?? undefined,
      poolHooks: lc(pc.hooks),
      poolFeeSuspect: isFeeSuspect(pc.fee),
      creatorAddress: creator,
      launchBlock: blockNumber,
      launchTxHash: txHash.toLowerCase(),
      launchAt,
      detectedVia: pc.detectedVia,
      lane: 'index',
      quotaExceeded,
      retrospective: deps.retrospective ?? false,
      feature: {
        create: {
          // v0.1 (2026-09-08): primary-pool selection — features derive from the
          // known-quote pool, re-checked at T+10m, not the first Initialize seen.
          schemaVersion: 'v0.1',
          creatorDevbuyPct: idx.creatorDevbuyPct,
          // feature 3 (creator_age_days / prior_*) is computed on the T+10m job —
          // the age nonce-search is 1-6s/RPC-call and must stay off the poller.
          hasX: idx.hasX,
          hasSite: idx.hasSite,
          // M4e — hook permissions are in the hook address bits (zero RPC)
          ...computeHookFeatures(pc.hooks),
          indexLaneComputedAt: new Date(),
          provenance: {
            source: {
              via: pc.detectedVia,
              block: Number(blockNumber),
              matchedAddress: attribution.matchedAddress,
              viaCandidate: attribution.viaCandidate,
            },
            pairClassification: { token, quote, confident },
            // bigints aren't valid JSON — narrow to a number for storage
            tokenFreshness: {
              isFreshLaunch: freshness.isFreshLaunch,
              reason: freshness.reason,
              checkedAtBlock: Number(freshness.checkedAtBlock),
            },
            creatorDevbuyPct: {
              launchTx: txHash,
              // spec §8.2: recipient-based, not tx.from
              recipient: idx.devbuyRecipient,
              recipientIsCreator: idx.devbuyRecipient === creator,
            },
          },
        },
      },
    },
  });

  if (deps.enqueueT10) {
    await deps.enqueueT10(launch.id);
  } else {
    await getQueues().features.add(
      't10',
      { launchId: launch.id },
      { delay: T10_DELAY_MS, jobId: `t10-${launch.id}`, removeOnComplete: true },
    );
  }

  return launch.id;
}
