/**
 * `runDeepdive` — one `llm_deepdive_v0` scored report for a launch (spec §5):
 * budget gate → frozen packet → agent loop → assemble + §8.3 validate + persist
 * (report-backed, so the scorer picks it up) → record the spend against the
 * gateway key. All I/O is injectable so the orchestration is unit-tested.
 */
import { getChainConfig } from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import { Worker } from 'bullmq';
import { loadEnv, type WorkerEnv } from '../env';
import { recordFailure } from '../failures';
import { QUEUE_NAMES, parseRedisUrl } from '../queues';
import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import { privateKeyToAccount } from 'viem/accounts';
import { deepdiveRunGate, dailyDeepdiveBudget } from '../metabolism/budget';
import { trailingCreditsUsd } from '../metabolism/credit-wallet';
import { readOAuthBlob, loadEncryptionKey, tokenStorePath } from '../metabolism/token-store';
import { totalSpendUsd } from '../metabolism/spend-ledger';
import { persistLaunchReports } from '../report';
import { rpc } from '../watcher/rpc';
import { runDeepdiveAgent } from './agent';
import { buildDeepdiveContext } from './context';
import { assembleDeepdiveReportSigned } from './report';
import { createDeepdiveClient, assertScoredModelSlug, type DeepdiveClient } from './openrouter';
import { buildTargetPacket, type DeepdiveTarget, type PacketClient } from './packet';
import { recordDeepdiveSpend } from './cost';
import type { DeepdiveContext } from './tools';
import type { DeepDiveResult } from './schema';

type Launch = NonNullable<Awaited<ReturnType<typeof prisma.launch.findUnique>>>;

export interface RunDeepdiveInput {
  launchId: string;
  trigger: string;
  /** pin the run to this block; default = current head */
  reportBlock?: bigint;
  /** re-run even if an llm_deepdive_v0 report already exists */
  force?: boolean;
}

export interface RunDeepdiveDeps {
  env?: WorkerEnv;
  packetClient?: PacketClient;
  buildContext?: (launch: Launch, env: WorkerEnv) => DeepdiveContext;
  client?: DeepdiveClient;
  runAgent?: typeof runDeepdiveAgent;
  loadBudget?: (env: WorkerEnv, now: Date) => Promise<{
    todaySpendUsd: number;
    spendableUsd: number;
    /** M5c — optional so an injected fake can return the pre-M5c shape */
    providerSpendTodayUsd?: number;
    billingStatus?: string | null;
    /** property 2 (2026-09-16) — optional so an injected fake can return the flat-cap shape */
    dailyCapUsd?: number;
    trailingCreditsUsd?: number | null;
    bindingConstraint?: string;
  }>;
  persist?: typeof persistLaunchReports;
  recordSpend?: typeof recordDeepdiveSpend;
  keyHashPrefix?: string | null;
  now?: () => Date;
  /** DB seams — default to Prisma */
  loadLaunch?: (id: string) => Promise<Launch | null>;
  existingDeepdiveReport?: (launchId: string) => Promise<{ id: string } | null>;
  reportIdByHash?: (reportHash: string) => Promise<string | null>;
}

export interface RunDeepdiveResult {
  ran: boolean;
  reason: string;
  reportHash?: string;
  validatorPassed?: boolean;
  validatorFailures?: string[];
  probabilities?: DeepDiveResult['output'];
  costUsd?: number;
  stoppedBy?: DeepDiveResult['stoppedBy'];
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function targetFromLaunch(l: Launch): DeepdiveTarget {
  return {
    chainId: l.chainId,
    tokenAddress: l.tokenAddress,
    quoteAddress: l.quoteAddress,
    creatorAddress: l.creatorAddress,
    launchBlock: l.launchBlock,
    launchTxHash: l.launchTxHash,
    launchAt: l.launchAt,
    source: l.source,
    pools: [
      {
        kind: (l.poolKind as 'v2' | 'v3' | 'v4' | null) ?? 'v4',
        poolAddress: l.poolAddress,
        poolId: l.poolId,
        feeHundredthsBip: l.poolFee,
        tickSpacing: l.poolTickSpacing,
        hooks: l.poolHooks,
        feeSuspect: l.poolFeeSuspect,
      },
    ],
  };
}

/**
 * Property 2 (spec §0.1): the daily deep-dive cap as a function of credits
 * accrued in the trailing 24h, not a fixed number — live since 2026-09-16.
 * Reads on-chain `Activated` events into the agent's account; falls back to
 * the flat `DEEPDIVE_DAILY_CAP_USD` when the CREDIT address or the agent
 * wallet isn't configured (local dev, or before this was wired in), so this
 * is additive, never a new way to fail closed.
 *
 * Consequence, deliberately: with no new funding, `trailingCreditsUsd` — and
 * so this cap — trends toward 0 about 24h after the last activation, even
 * while real balance remains. That is the property working as specified
 * (spec §8: "throughput visibly follows token activity"), not a bug.
 */
async function dynamicDailyCapUsd(
  env: WorkerEnv,
  spendableUsd: number,
): Promise<{ dailyCapUsd: number; trailingCreditsUsd: number | null; bindingConstraint: string }> {
  const creditAddr = process.env.ORBIO_CREDIT_ADDRESS as `0x${string}` | undefined;
  if (!creditAddr || !env.gasWalletPrivateKey) {
    return { dailyCapUsd: env.deepdiveDailyCapUsd, trailingCreditsUsd: null, bindingConstraint: 'daily_cap' };
  }
  try {
    const wallet = privateKeyToAccount(env.gasWalletPrivateKey).address;
    const pub = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.deepdive });
    const trailing = await trailingCreditsUsd(pub, creditAddr, wallet, 9_999n);
    const b = dailyDeepdiveBudget({
      dailyCapUsd: env.deepdiveDailyCapUsd,
      trailingCreditsUsd: trailing,
      keyRemainingUsd: spendableUsd + env.metabolismReserveUsd, // dailyDeepdiveBudget re-subtracts the reserve
      reserveUsd: env.metabolismReserveUsd,
    });
    return { dailyCapUsd: b.budgetUsd, trailingCreditsUsd: trailing, bindingConstraint: b.bindingConstraint };
  } catch (err) {
    // an RPC hiccup here must not take down deep-dive entirely — fall back,
    // and say so, rather than silently using a number nobody can explain.
    console.warn('[deepdive] dynamicDailyCapUsd failed, using the flat cap:', err instanceof Error ? err.message : err);
    return { dailyCapUsd: env.deepdiveDailyCapUsd, trailingCreditsUsd: null, bindingConstraint: 'daily_cap' };
  }
}

async function defaultLoadBudget(
  env: WorkerEnv,
  now: Date,
): Promise<{
  todaySpendUsd: number;
  providerSpendTodayUsd: number;
  spendableUsd: number;
  billingStatus: string | null;
  dailyCapUsd: number;
  trailingCreditsUsd: number | null;
  bindingConstraint: string;
}> {
  const dayStart = startOfUtcDay(now);
  const [todaySpendUsd, providerAgg, snap] = await Promise.all([
    totalSpendUsd({ since: dayStart }),
    // M5c: the authoritative figure — Σ provider deltas over today's epochs
    prisma.metabolismEpoch.aggregate({ _sum: { providerDeltaUsd: true }, where: { at: { gte: dayStart } } }),
    prisma.lifecycleLog.findFirst({
      where: { balanceUsd: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { balanceUsd: true, billingStatus: true, createdAt: true },
    }),
  ]);
  const spendableUsd =
    snap?.balanceUsd != null ? snap.balanceUsd - env.metabolismReserveUsd : env.deepdiveDailyCapUsd;

  // M5c: if the lifecycle runner has not written a snapshot recently, the
  // provider figure is stale and the safety loop is blind (e.g. the Orbio MCP
  // session lapsed). Route conservatively: refuse inference rather than spend
  // against a balance nobody is watching. Three missed polls is the threshold.
  const staleAfterMs = env.metabolismStatusPollSec * 1000 * 3;
  const snapAt = snap?.createdAt?.getTime() ?? 0;
  const stale = now.getTime() - snapAt > staleAfterMs;

  const dyn = await dynamicDailyCapUsd(env, spendableUsd);

  return {
    todaySpendUsd,
    providerSpendTodayUsd: providerAgg._sum.providerDeltaUsd ?? 0,
    spendableUsd,
    billingStatus: stale ? 'stale' : (snap?.billingStatus ?? null),
    dailyCapUsd: dyn.dailyCapUsd,
    trailingCreditsUsd: dyn.trailingCreditsUsd,
    bindingConstraint: dyn.bindingConstraint,
  };
}

function defaultKeyHashPrefix(env: WorkerEnv): string | null {
  try {
    if (!process.env.TOKEN_ENCRYPTION_KEY) return null;
    return (
      readOAuthBlob(tokenStorePath(), loadEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY)).gatewayKeyPrefix ??
      null
    );
  } catch {
    return null;
  }
}

export async function runDeepdive(
  input: RunDeepdiveInput,
  deps: RunDeepdiveDeps = {},
): Promise<RunDeepdiveResult> {
  const env = deps.env ?? loadEnv();
  const now = (deps.now ?? (() => new Date()))();

  try {
    assertScoredModelSlug(env.openrouterModelDeepdive);
  } catch (e) {
    return { ran: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const loadLaunch =
    deps.loadLaunch ?? ((id: string) => prisma.launch.findUnique({ where: { id } }));
  const launch = await loadLaunch(input.launchId);
  if (!launch) return { ran: false, reason: `launch ${input.launchId} not found` };

  if (!input.force) {
    const existing = deps.existingDeepdiveReport
      ? await deps.existingDeepdiveReport(launch.id)
      : await prisma.report.findFirst({
          where: { launchId: launch.id, forecaster: 'llm_deepdive_v0' },
          select: { id: true },
        });
    if (existing) return { ran: false, reason: 'already scored by llm_deepdive_v0' };
  }

  const loadBudget = deps.loadBudget ?? defaultLoadBudget;
  const budget = await loadBudget(env, now);
  const gate = deepdiveRunGate({
    capPerRunUsd: env.deepdiveCapPerRunUsd,
    dailyCapUsd: budget.dailyCapUsd ?? env.deepdiveDailyCapUsd,
    todaySpendUsd: budget.todaySpendUsd,
    providerSpendTodayUsd: budget.providerSpendTodayUsd,
    spendableUsd: budget.spendableUsd,
    billingStatus: budget.billingStatus,
  });
  if (!gate.allowed) {
    const credit = budget.trailingCreditsUsd != null ? ` (24h credit accrual $${budget.trailingCreditsUsd.toFixed(2)}, bound by ${budget.bindingConstraint})` : '';
    return { ran: false, reason: `budget: ${gate.reason}${credit}` };
  }

  const packetClient = deps.packetClient ?? (rpc() as unknown as PacketClient);
  const packet = await buildTargetPacket(packetClient, targetFromLaunch(launch), input.reportBlock);

  const buildContext =
    deps.buildContext ??
    ((l: Launch, e: WorkerEnv) =>
      buildDeepdiveContext(l, { rpc: rpc(), scanhoodBaseUrl: e.scanhoodApiBase }, getChainConfig(l.chainId)));
  const ctx = buildContext(launch, env);

  const client = deps.client ?? createDeepdiveClient(env);
  const runAgent = deps.runAgent ?? runDeepdiveAgent;

  const result = await runAgent({
    client,
    ctx,
    packet,
    maxSteps: env.deepdiveMaxSteps,
    maxCostUsd: Math.min(gate.maxRunCostUsd, env.deepdiveCapPerRunUsd),
  });

  // 2026-09-12: the model never ran (e.g. the pinned slug has no provider —
  // `sakana/fugu-max` 404'd on every call). Every prior run still built, signed,
  // and persisted+committed a report of all-zero probabilities with "model run
  // did not complete" as its only evidence — 168 of them, now permanently
  // on-chain. That is not a lie (the report says exactly what happened), but it
  // is a placeholder wearing a forecast's signature. A run that never produced a
  // measurement is not a scored pass: no report at all, same as every other
  // early-exit in this function (missing launch, budget gate, already scored).
  if (result.stoppedBy === 'error') {
    return { ran: false, reason: `model run failed: ${result.warnings.join('; ') || 'unknown error'}` };
  }

  const draft = await assembleDeepdiveReportSigned({
    chainId: launch.chainId,
    tokenAddress: launch.tokenAddress,
    launchId: launch.id,
    trigger: input.trigger,
    packet,
    result,
    agentPrivateKey: env.agentPrivateKey,
  });

  const persist = deps.persist ?? persistLaunchReports;
  await persist([draft]);

  const reportId = deps.reportIdByHash
    ? await deps.reportIdByHash(draft.reportHash)
    : (
        await prisma.report.findUnique({
          where: { reportHash: draft.reportHash },
          select: { id: true },
        })
      )?.id ?? null;

  const recordSpend = deps.recordSpend ?? recordDeepdiveSpend;
  const keyHashPrefix = deps.keyHashPrefix ?? defaultKeyHashPrefix(env);
  const spend = await recordSpend({ result, keyHashPrefix, reportId }, { env });
  if (spend.costBasis === 'unavailable') {
    // never silent: the epoch reconciler will mark this window `unavailable`
    // eslint-disable-next-line no-console
    console.warn(
      `[deepdive] no cost basis for this run (no provider cost, no priced tokens)` +
        (spend.failureReason ? ` — ${spend.failureReason}` : ''),
    );
  }

  return {
    ran: true,
    reason: draft.validatorPassed ? 'ok' : `stored, validator failed: ${draft.validatorFailures.join('; ')}`,
    reportHash: draft.reportHash,
    validatorPassed: draft.validatorPassed,
    validatorFailures: draft.validatorFailures,
    probabilities: result.output,
    costUsd: spend.totalCostUsd,
    stoppedBy: result.stoppedBy,
  };
}

/* ───────────────────────── qualified-lane sweep ───────────────────────── */

export interface DeepdiveSweepResult {
  eligible: number;
  ran: number;
  skipped: number;
  failed: number;
}

/**
 * Score up to `limit` qualified-lane launches that have a T+10m feature row and
 * no `llm_deepdive_v0` report yet, oldest first. Stops early when `runDeepdive`
 * reports the budget is exhausted.
 */
export async function sweepDeepdiveEligible(
  limit = 5,
  deps: RunDeepdiveDeps = {},
): Promise<DeepdiveSweepResult> {
  const out: DeepdiveSweepResult = { eligible: 0, ran: 0, skipped: 0, failed: 0 };
  const launches = await prisma.launch.findMany({
    where: {
      lane: 'qualified',
      retrospective: false,
      quotaExceeded: false,
      feature: { isNot: null },
      reports: { none: { forecaster: 'llm_deepdive_v0' } },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  out.eligible = launches.length;

  // Why a sweep skipped is as important as that it did. Twice now a silent
  // `skipped` count has hidden a real outage for days — a dead model slug, then
  // a missing gateway key — because only budget reasons were ever logged.
  const skipReasons = new Map<string, number>();
  for (const l of launches) {
    try {
      const r = await runDeepdive({ launchId: l.id, trigger: 'qualified' }, deps);
      if (r.ran) {
        out.ran += 1;
      } else {
        out.skipped += 1;
        skipReasons.set(r.reason, (skipReasons.get(r.reason) ?? 0) + 1);
        if (r.reason.startsWith('budget:')) {
          // eslint-disable-next-line no-console
          console.log(`[deepdive] stopping sweep — ${r.reason}`);
          break;
        }
      }
    } catch (err) {
      out.failed += 1;
      // eslint-disable-next-line no-console
      console.error(`[deepdive] ${l.id} failed:`, err instanceof Error ? err.message : err);
      await recordFailure('deepdive.run_failed', err);
    }
  }
  if (skipReasons.size > 0) {
    const summary = [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n}x ${reason}`)
      .join(' · ');
    // eslint-disable-next-line no-console
    console.log(`[deepdive] skips: ${summary}`);
  }
  return out;
}

/**
 * BullMQ consumer for on-demand runs (`POST /v1/deepdive/{token}` enqueues
 * `{ tokenAddress, trigger: 'on_demand' }`). The periodic sweep handles the
 * qualified lane; this handles buyer-triggered assessments.
 */
export function startDeepdiveWorker(): Worker {
  const connection = parseRedisUrl(loadEnv().redisUrl);
  return new Worker(
    QUEUE_NAMES.deepdive,
    async (job) => {
      const d = job.data as { tokenAddress?: string; launchId?: string; trigger?: string };
      let launchId = d.launchId;
      if (!launchId && d.tokenAddress) {
        const l = await prisma.launch.findFirst({
          where: { tokenAddress: d.tokenAddress.toLowerCase() },
          select: { id: true },
        });
        launchId = l?.id;
      }
      if (!launchId) return { ran: false, reason: 'no launch for token' };
      const trigger = d.trigger ?? 'on_demand';
      return runDeepdive({ launchId, trigger, force: trigger === 'on_demand' });
    },
    { connection, concurrency: 1 },
  );
}

export async function runDeepdiveLoop(
  signal: { stopped: boolean },
  opts: { intervalMs?: number; batch?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 120_000;
  const batch = opts.batch ?? 5;
  // eslint-disable-next-line no-console
  console.log(`[deepdive] qualified-lane sweep every ${intervalMs / 1000}s, batch ${batch}`);
  while (!signal.stopped) {
    try {
      const r = await sweepDeepdiveEligible(batch);
      if (r.eligible > 0) {
        // eslint-disable-next-line no-console
        console.log(`[deepdive] swept ${r.eligible}: ${r.ran} scored · ${r.skipped} skipped · ${r.failed} error`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[deepdive] sweep error', err instanceof Error ? err.message : err);
      await recordFailure('deepdive.sweep_error', err);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
