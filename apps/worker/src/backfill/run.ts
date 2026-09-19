import {
  POOL_EVENT_TOPIC0,
  getChainConfig,
  getGetLogsMaxRange,
  poolCreationSources,
  setGetLogsMaxRange,
} from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import { budgetStats, getBudgetedClient, PRIORITY, probeGetLogsRange } from '@launch-auditor/rpc-budget';
import type { PublicClient } from 'viem';
import { loadEnv } from '../env';
import { blockAtTime } from '../outcomes/block-time';
import { sweepDueOutcomes, type SweepResult } from '../outcomes/loop';
import { detectPools } from '../watcher/detect';
import { ingestPool } from '../watcher/ingest';
import { pickPrimaryV4Pool } from '../watcher/primary-pool';
import { withDeadline } from '../watcher/retry';
import { runT10ForLaunch } from '../watcher/t10';

export interface BackfillOptions {
  /** window length in days of chain history (spec §7; checkpoint cut 45 -> 14) */
  days: number;
  /** hard cap on RPC calls for this run; 0 = unbounded */
  maxCalls: number;
  dryRun?: boolean;
  fromBlock?: bigint;
  toBlock?: bigint;
  /** end the window this many hours before now (so discovered launches' horizons
   *  have already passed and can resolve — chain 4663 launches ~14k/day, so a
   *  full backfill is infeasible; sample instead) */
  endHoursAgo?: number;
  /** stop discovery once this many launches are carried to features/outcomes */
  maxLaunches?: number;
  /** index only pools with a confidently-identified quote asset (skip the many
   *  token-vs-token pools) — cleaner base rates */
  confidentOnly?: boolean;
  /** heavy scans (cluster / INSIDER / SELL / LIQ) on qualified launches only */
  qualifiedOnly?: boolean;
  /** skip pool discovery + ingest; just run T+10m + outcomes on existing retrospective rows */
  resolveOnly?: boolean;
  /** stop after discovery + features, before outcome resolution */
  featuresOnly?: boolean;
  /** skip the T+10m feature backfill entirely; go straight to outcome resolution
   *  on rows that already have features (fastest path to base rates) */
  skipFeatures?: boolean;
  /** resolve only these outcome labels (fill one sparse base-rate cell at a time) */
  onlyLabels?: string[];
  /** 'spread' resolves across cells (id order) instead of oldest-horizon-first */
  sweepOrder?: 'horizon' | 'spread';
  /** resolve outcomes for qualified-lane launches only, for every label */
  laneQualifiedOnly?: boolean;
  /** re-run T+10m for every retrospective launch, not just the unfeatured ones */
  refeature?: boolean;
  /** cheap pass: just re-derive each retrospective launch's primary v4 pool
   *  (after the M4 pool-selection fix) — ~4 getLogs each, no full re-feature */
  repool?: boolean;
  /** skip these outcome labels in the sweep (e.g. deprioritise INSIDER_EXIT) */
  excludeLabels?: string[];
  log?: (msg: string) => void;
}

export interface BackfillResult {
  window: { fromBlock: number; toBlock: number; days: number };
  estimatedCalls: number;
  launchesIngested: number;
  t10Ran: number;
  t10Failed: number;
  outcomes: SweepResult;
  callsUsed: number;
  stoppedEarly: boolean;
}

const emptySweep = (): SweepResult => ({
  picked: 0,
  resolved: 0,
  na: 0,
  unresolvable: 0,
  retryLater: 0,
  failed: 0,
});

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { rpcUrl, chainId, headLagBlocks, rpcMaxGetLogsRange } = loadEnv();
  const client = getBudgetedClient(rpcUrl, { priority: PRIORITY.backfill }) as PublicClient;
  const qualifiedOnly = opts.qualifiedOnly ?? true;

  // getLogs span
  const head = await client.getBlockNumber();
  if (rpcMaxGetLogsRange > 0) {
    setGetLogsMaxRange(rpcMaxGetLogsRange);
  } else {
    try {
      const { v4PoolManager } = poolCreationSources(chainId);
      const probe = probeGetLogsRange((a) => client.request(a as never) as Promise<unknown>, {
        address: v4PoolManager,
        anchorBlock: head - 5n,
        candidates: [9_999, 5_000, 2_000],
        topics: [POOL_EVENT_TOPIC0.v4Initialize], // sparse — an unfiltered scan can hang the RPC
      });
      const timeout = new Promise<number>((_, rej) =>
        setTimeout(() => rej(new Error('probe timeout')), 25_000),
      );
      setGetLogsMaxRange(await Promise.race([probe, timeout]));
    } catch (err) {
      log(`[backfill] getLogs-range probe skipped (${(err as Error).message}); using ${getGetLogsMaxRange(chainId)}`);
    }
  }
  const maxRange = getGetLogsMaxRange(chainId);

  const toBlock =
    opts.toBlock ??
    (opts.endHoursAgo
      ? await blockAtTime(client, new Date(Date.now() - opts.endHoursAgo * 3_600_000), { chainId })
      : head > headLagBlocks
        ? head - headLagBlocks
        : head);
  const fromBlock =
    opts.fromBlock ??
    (await blockAtTime(client, new Date(Date.now() - opts.days * 86_400_000), { chainId }));
  const maxLaunches = opts.maxLaunches ?? Number.POSITIVE_INFINITY;

  const spanBlocks = toBlock > fromBlock ? Number(toBlock - fromBlock) : 0;
  // chain 4663 runs ~14k launches/day — a full backfill is infeasible, so a
  // 3-day base-rate pass caps `maxLaunches` and samples from the front.
  const perDay = 14_000;
  const discoverChunks = Number.isFinite(maxLaunches)
    ? Math.ceil((maxLaunches / perDay) * (86_400 / (maxRange * 0.1))) // chunks until maxLaunches hit
    : Math.ceil(spanBlocks / maxRange);
  const expectedLaunches = Number.isFinite(maxLaunches)
    ? maxLaunches
    : Math.max(1, Math.round((spanBlocks * 0.1 * perDay) / 86_400));
  const skipDiscovery = opts.resolveOnly || opts.skipFeatures;
  let estimatedCalls: number;
  if (skipDiscovery) {
    // no discovery window — the work is bounded by pending due outcomes
    const [duePending, unfeatured] = await Promise.all([
      prisma.outcome.count({ where: { status: 'PENDING', horizonAt: { lte: new Date() } } }),
      opts.skipFeatures
        ? Promise.resolve(0)
        : prisma.launch.count({ where: { retrospective: true, feature: { t10ComputedAt: null } } }),
    ]);
    estimatedCalls = duePending * 90 + unfeatured * 40;
    log(
      `[backfill] resolve pass — ${duePending} due PENDING outcomes` +
        (unfeatured ? ` + ${unfeatured} unfeatured launches` : '') +
        `, getLogs span ${maxRange}, est. RPC calls ~${estimatedCalls.toLocaleString()}` +
        (opts.maxCalls > 0 ? `, cap ${opts.maxCalls.toLocaleString()}` : ', uncapped'),
    );
  } else {
    estimatedCalls =
      discoverChunks + // one filtered getLogs per chunk
      expectedLaunches * 6 + // freshness + index features per ingested launch
      expectedLaunches * 40 + // T+10m features
      expectedLaunches * 80 + // DRAWDOWN price series
      Math.round(expectedLaunches * 0.3) * 250; // heavy scans on the qualified ~30%
    log(
      `[backfill] window blocks ${fromBlock}..${toBlock} (${opts.days}d, ~${spanBlocks} blocks), ` +
        `getLogs span ${maxRange}, est. RPC calls ~${estimatedCalls.toLocaleString()}` +
        (opts.maxCalls > 0 ? `, cap ${opts.maxCalls.toLocaleString()}` : ', uncapped'),
    );
  }

  const result: BackfillResult = {
    window: { fromBlock: Number(fromBlock), toBlock: Number(toBlock), days: opts.days },
    estimatedCalls,
    launchesIngested: 0,
    t10Ran: 0,
    t10Failed: 0,
    outcomes: emptySweep(),
    callsUsed: 0,
    stoppedEarly: false,
  };
  if (opts.dryRun) {
    log('[backfill] dry run — not executing');
    return result;
  }

  const startCalls = budgetStats(rpcUrl).started;
  const used = (): number => budgetStats(rpcUrl).started - startCalls;
  const overBudget = (): boolean => opts.maxCalls > 0 && used() >= opts.maxCalls;

  // ── 0. re-derive the primary pool (cheap; after the M4 pool-selection fix) ──
  if (opts.repool) {
    const rows = await prisma.launch.findMany({
      where: { retrospective: true, OR: [{ poolKind: 'v4' }, { poolKind: null }] },
      select: { id: true, chainId: true, tokenAddress: true, poolId: true, launchBlock: true },
    });
    const secs = getChainConfig(chainId).approxBlockSeconds;
    const scanBlocks = BigInt(Math.round((2 * 3600) / secs)); // 2h forward — the primary pool exists by then
    const win = BigInt(Math.round((10 * 60) / secs));
    let switched = 0;
    let checked = 0;
    for (const r of rows) {
      if (overBudget()) {
        result.stoppedEarly = true;
        break;
      }
      try {
        const pick = await withDeadline(
          () =>
            pickPrimaryV4Pool(client, {
              chainId: r.chainId,
              token: r.tokenAddress,
              currentPoolId: r.poolId,
              scanFrom: r.launchBlock,
              scanTo: r.launchBlock + scanBlocks,
              activityFrom: r.launchBlock,
              activityTo: r.launchBlock + win,
              maxRange,
            }),
          60_000,
          `repool ${r.id}`,
        );
        checked++;
        if (pick.chosen && pick.changed) {
          switched++;
          await prisma.launch.update({
            where: { id: r.id },
            data: {
              poolKind: 'v4',
              poolId: pick.chosen.poolId,
              poolAddress: null,
              poolFee: pick.chosen.fee ?? undefined,
              poolTickSpacing: pick.chosen.tickSpacing ?? undefined,
              poolHooks: pick.chosen.hooks,
              quoteAddress: pick.chosen.quote ?? undefined,
              poolFeeSuspect: pick.chosen.feeSuspect,
              primaryPoolCheckedAt: new Date(),
            },
          });
        } else if (pick.chosen) {
          await prisma.launch.update({
            where: { id: r.id },
            data: { poolFeeSuspect: pick.chosen.feeSuspect, primaryPoolCheckedAt: new Date() },
          });
        }
      } catch (err) {
        log(`[backfill] repool ${r.id} failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    log(`[backfill] repool: ${switched}/${checked} launches switched pools, ${used()} calls`);
  }

  // ── 1. discovery + ingest ────────────────────────────────────────────
  const launchIds: string[] = [];
  if (!opts.resolveOnly) {
    for (
      let from = fromBlock;
      from <= toBlock && !overBudget() && launchIds.length < maxLaunches;
      from += BigInt(maxRange)
    ) {
      const to = from + BigInt(maxRange) - 1n < toBlock ? from + BigInt(maxRange) - 1n : toBlock;
      let detected;
      try {
        detected = await detectPools(client, chainId, from, to, maxRange);
      } catch (err) {
        log(`[backfill] discovery ${from}..${to} failed: ${(err as Error).message.split('\n')[0]}`);
        continue;
      }
      for (const dp of detected) {
        if (overBudget() || launchIds.length >= maxLaunches) break;
        try {
          const id = await ingestPool(dp, {
            client,
            chainId,
            quotaPerCreator24h: loadEnv().quotaPerCreator24h,
            retrospective: true,
            confidentOnly: opts.confidentOnly ?? false,
            enqueueT10: async () => {},
          });
          if (id) {
            launchIds.push(id);
            result.launchesIngested++;
          }
        } catch (err) {
          log(`[backfill] ingest ${dp.txHash} failed: ${(err as Error).message.split('\n')[0]}`);
        }
      }
      if (detected.length) log(`[backfill] ${from}..${to}: +${result.launchesIngested} launches, ${used()} calls`);
    }
  }

  // ── 2. T+10m features (frozen code) ─────────────────────────────────
  // --refeature: re-run T+10m for ALL retrospective launches, not just the
  // unfeatured ones — needed after the primary-pool fix so historical rows stop
  // pointing at decoy side pools.
  const toFeature = opts.skipFeatures
    ? []
    : opts.resolveOnly
      ? (
          await prisma.launch.findMany({
            where: {
              retrospective: true,
              ...(opts.refeature ? {} : { feature: { t10ComputedAt: null } }),
            },
            select: { id: true },
          })
        ).map((l) => l.id)
      : launchIds;

  for (const id of toFeature) {
    if (overBudget()) {
      result.stoppedEarly = true;
      break;
    }
    try {
      // one launch's feature scan must not stall the whole run (24h-hang guard)
      await withDeadline(() => runT10ForLaunch(client, id), 120_000, `t10 ${id}`);
      result.t10Ran++;
    } catch (err) {
      result.t10Failed++;
      log(`[backfill] T+10m ${id} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  if (toFeature.length) {
    log(`[backfill] features: ${result.t10Ran} ok, ${result.t10Failed} failed, ${used()} calls`);
  }

  // ── 3. outcome resolution ──────────────────────────────────────────
  if (!opts.featuresOnly) {
    let quiet = 0;
    while (!overBudget() && quiet < 2) {
      const r = await sweepDueOutcomes(client, 60, {
        qualifiedOnly,
        concurrency: 8,
        onlyLabels: opts.onlyLabels as never,
        excludeLabels: opts.excludeLabels as never,
        order: opts.sweepOrder,
        laneQualifiedOnly: opts.laneQualifiedOnly,
      });
      result.outcomes.picked += r.picked;
      result.outcomes.resolved += r.resolved;
      result.outcomes.na += r.na;
      result.outcomes.unresolvable += r.unresolvable;
      result.outcomes.retryLater += r.retryLater;
      result.outcomes.failed += r.failed;
      if (r.picked === 0) quiet++;
      else {
        quiet = 0;
        log(
          `[backfill] outcomes +${r.resolved} resolved / ${r.na} n/a / ${r.unresolvable} unres / ` +
            `${r.retryLater} retry — ${used()} calls`,
        );
      }
    }
  }

  result.callsUsed = used();
  result.stoppedEarly = result.stoppedEarly || overBudget();
  log(
    `[backfill] done — ${result.launchesIngested} ingested, ${result.t10Ran} featured, ` +
      `${result.outcomes.resolved} outcomes resolved, ${result.callsUsed} RPC calls` +
      (result.stoppedEarly ? ' (STOPPED AT CAP)' : ''),
  );
  return result;
}

/** observed base rate per (label, horizon) among RESOLVED retrospective outcomes.
 *  qualifiedLaneOnly: restrict to launches that reached the qualified lane — the
 *  population det_v0 actually scores; non-qualified retrospective launches are
 *  mostly spam / side-pool noise and bias the rate. */
export async function observedBaseRates(
  opts: { qualifiedLaneOnly?: boolean } = {},
): Promise<Array<{ key: string; n: number; positives: number; rate: number }>> {
  const rows = await prisma.outcome.findMany({
    where: {
      status: 'RESOLVED',
      value: { not: null },
      retrospective: true,
      ...(opts.qualifiedLaneOnly ? { launch: { lane: 'qualified' } } : {}),
    },
    select: { label: true, horizon: true, value: true },
  });
  const acc = new Map<string, { n: number; pos: number }>();
  for (const r of rows) {
    const k = `${r.label}@${r.horizon}`;
    const a = acc.get(k) ?? { n: 0, pos: 0 };
    a.n++;
    if (r.value) a.pos++;
    acc.set(k, a);
  }
  return [...acc.entries()]
    .map(([key, a]) => ({ key, n: a.n, positives: a.pos, rate: a.n ? a.pos / a.n : 0 }))
    .sort((x, y) => x.key.localeCompare(y.key));
}
