import { prisma } from '@launch-auditor/db';
import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import {
  ALL_OUTCOME_KEYS,
  goplusToProbabilities,
  scanhoodToProbabilities,
  type OutcomeKey,
  type ScoreRow,
} from '@launch-auditor/scoring';
import { loadEnv } from '../env';
import { horizonMs } from '../outcomes/resolve';
import {
  classifyEligibility,
  countExclusion,
  scannerFetchIsTimely,
  type Eligibility,
  type ExclusionCounts,
} from './eligibility';

/** OutcomeKey -> the Report probability column that holds that forecast. */
const P_COL: Partial<Record<OutcomeKey, string>> = {
  'INSIDER_EXIT@6h': 'pInsiderExit6h',
  'INSIDER_EXIT@24h': 'pInsiderExit24h',
  'INSIDER_EXIT@72h': 'pInsiderExit72h',
  'SELL_IMPAIRED@1h': 'pSellImpaired1h',
  'SELL_IMPAIRED@24h': 'pSellImpaired24h',
  'LIQ_IMPAIRED@24h': 'pLiqImpaired24h',
  'LIQ_IMPAIRED@7d': 'pLiqImpaired7d',
  'DRAWDOWN_80@24h': 'pDrawdown80_24h',
  'DRAWDOWN_80@7d': 'pDrawdown80_7d',
  'TRADING_ALIVE@24h': 'pTradingAlive24h',
  'TRADING_ALIVE@7d': 'pTradingAlive7d',
};

/** Forecasters computed here rather than read from a committed report; they inherit det_v0's eligibility. */
const REFERENCE_FORECASTER = 'det_v0';

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
const obsKey = (chainId: number, token: string, anchor: Date): string =>
  `${chainId}|${token.toLowerCase()}|${anchor.toISOString()}`;
const horizonEndOf = (anchor: Date, key: OutcomeKey): Date =>
  new Date(anchor.getTime() + horizonMs(key.split('@')[1]!));

interface ResolvedObs {
  chainId: number;
  token: string;
  anchor: Date;
  trigger: string;
  launchId: string | null;
  labels: Map<OutcomeKey, boolean>;
}

/** Chain timestamp of a block. Immutable, so cached for the life of the process. */
export type BlockTimeReader = (blockNumber: bigint) => Promise<Date | null>;

// Caches the in-flight promise, not just the result: the snapshot loop runs
// the `both` and `live` passes concurrently, and caching only finished reads
// made both passes fetch every block on a cold start. Failures are evicted so
// a later snapshot retries them.
const blockTimeCache = new Map<string, Promise<Date | null>>();
const defaultBlockTimeReader: BlockTimeReader = (blockNumber) => {
  const k = blockNumber.toString();
  const hit = blockTimeCache.get(k);
  if (hit) return hit;
  const { rpcUrl } = loadEnv();
  if (!rpcUrl) return Promise.resolve(null);
  // commit priority, not outcomes: these are one-time reads of commit blocks
  // (~1 per batch, cached for good), and at outcomes priority a report backlog
  // at watcher priority starved them — the 19 Sep first snapshot never finished.
  const p = getBudgetedClient(rpcUrl, { priority: PRIORITY.commit })
    .getBlock({ blockNumber })
    .then((block) => new Date(Number(block.timestamp) * 1000))
    .catch(() => {
      blockTimeCache.delete(k);
      return null; // "missing_time", never a guess
    });
  blockTimeCache.set(k, p);
  return p;
};

export interface CollectOptions {
  /** include retrospective (backfill) rows, live rows, or both (default) */
  scope?: 'live' | 'retrospective' | 'both';
  /** injectable for tests — defaults to a cached RPC `getBlock` */
  blockTimeOf?: BlockTimeReader;
}

export interface CollectResult {
  /** eligible report-outcome pairs only — the rows every claim is computed from */
  rows: ScoreRow[];
  /** every pair, eligible or not, counted by class per outcome and forecaster */
  exclusions: ExclusionCounts;
}

/**
 * Join resolved outcomes with every forecaster's prediction for the same
 * (token, anchor time). Report-backed forecasters (det_v0, det_v0.1,
 * heuristic_v1, llm_deepdive_v0) are classified from their own commit's chain
 * block time; the computed ones (base_rate, base_rate_fixed, scanhood, goplus)
 * take det_v0's class for the same observation so every forecaster in a cell
 * is scored on the same rows. Only `eligible` pairs are returned as rows.
 */
export async function collectScoreRows(opts: CollectOptions = {}): Promise<CollectResult> {
  const scope = opts.scope ?? 'both';
  const blockTimeOf = opts.blockTimeOf ?? defaultBlockTimeReader;
  const exclusions: ExclusionCounts = {};

  const outcomeWhere: Record<string, unknown> = { status: 'RESOLVED', value: { not: null } };
  if (scope === 'live') outcomeWhere['retrospective'] = false;
  if (scope === 'retrospective') outcomeWhere['retrospective'] = true;

  const outcomes = await prisma.outcome.findMany({ where: outcomeWhere });
  const obs = new Map<string, ResolvedObs>();
  for (const o of outcomes) {
    const k = obsKey(o.chainId, o.tokenAddress, o.anchorTime);
    let entry = obs.get(k);
    if (!entry) {
      entry = {
        chainId: o.chainId,
        token: o.tokenAddress.toLowerCase(),
        anchor: o.anchorTime,
        trigger: o.trigger,
        launchId: o.launchId,
        labels: new Map(),
      };
      obs.set(k, entry);
    }
    entry.labels.set(`${o.label}@${o.horizon}` as OutcomeKey, o.value === true);
  }
  if (obs.size === 0) return { rows: [], exclusions };

  // trailing-30-day base rate per outcome key
  const perKey: Record<string, Array<{ t: number; y: boolean }>> = {};
  for (const e of obs.values()) {
    for (const [key, y] of e.labels) {
      (perKey[key] ??= []).push({ t: e.anchor.getTime(), y });
    }
  }
  for (const arr of Object.values(perKey)) arr.sort((a, b) => a.t - b.t);
  const trailingBaseRate = (key: OutcomeKey, at: number): number => {
    const arr = perKey[key] ?? [];
    let pos = 0;
    let tot = 0;
    for (const r of arr) {
      if (r.t >= at) break;
      if (r.t >= at - THIRTY_DAYS_MS) {
        tot++;
        if (r.y) pos++;
      }
    }
    if (tot === 0) {
      const all = arr.filter((r) => r.t < at);
      return all.length ? all.filter((r) => r.y).length / all.length : 0;
    }
    return pos / tot;
  };

  const rows: ScoreRow[] = [];
  /** `${obsKey}|${outcomeKey}` -> det_v0's class, which the computed forecasters inherit */
  const refClass = new Map<string, Eligibility>();

  // report-backed forecasters, oldest first so each launch's scanner anchor is deterministic
  const reports = await prisma.report.findMany({
    where: { validatorPassed: true },
    orderBy: [{ reportTime: 'asc' }, { createdAt: 'asc' }],
    include: {
      launch: { select: { source: true } },
      commit: { select: { blockNumber: true } },
    },
  });
  // warm the block-time cache for every commit a scored report sits in, in parallel chunks
  const blocks = [
    ...new Set(
      reports
        .filter((r) => r.commit?.blockNumber != null && obs.has(obsKey(r.chainId, r.tokenAddress, r.reportTime)))
        .map((r) => r.commit!.blockNumber!.toString()),
    ),
  ];
  const blockTimes = new Map<string, Date | null>();
  for (let i = 0; i < blocks.length; i += 50) {
    const chunk = blocks.slice(i, i + 50);
    const times = await Promise.all(chunk.map((b) => blockTimeOf(BigInt(b))));
    chunk.forEach((b, j) => blockTimes.set(b, times[j] ?? null));
  }

  const launchAnchor = new Map<string, string>(); // launchId -> obsKey of its earliest launch/qualified report
  for (const r of reports) {
    const k = obsKey(r.chainId, r.tokenAddress, r.reportTime);
    const e = obs.get(k);
    if (!e) continue;
    if (r.launchId && (r.trigger === 'launch' || r.trigger === 'qualified') && !launchAnchor.has(r.launchId)) {
      launchAnchor.set(r.launchId, k);
    }
    const source = r.launch?.source ?? 'unknown';
    const committed = r.commitId != null && r.commit?.blockNumber != null;
    const commitBlockTime = committed ? (blockTimes.get(r.commit!.blockNumber!.toString()) ?? null) : null;
    for (const key of ALL_OUTCOME_KEYS) {
      const y = e.labels.get(key);
      if (y === undefined) continue;
      const col = P_COL[key];
      if (!col) continue;
      const prob = (r as unknown as Record<string, number | null>)[col];
      if (prob === null || prob === undefined) continue;
      const cls = classifyEligibility({
        reportTime: r.reportTime,
        committed,
        commitBlockTime,
        horizonEnd: horizonEndOf(r.reportTime, key),
      });
      countExclusion(exclusions, key, r.forecaster, cls);
      if (r.forecaster === REFERENCE_FORECASTER && !refClass.has(`${k}|${key}`)) refClass.set(`${k}|${key}`, cls);
      if (cls !== 'eligible') continue;
      rows.push({ obsId: k, forecaster: r.forecaster, outcomeKey: key, trigger: r.trigger, source, prob, label: y });
    }
  }

  // base_rate_fixed — a constant climatology per outcome key (whole-sample
  // prevalence, same probability for every observation, no notion of time).
  // Codex Phase B #3: the rolling base_rate is a same-stream, time-varying
  // predictor whose live AUROC was ~0.37/0.42, not the ~0.5 a constant
  // predictor should score. This forecaster is the honest floor that claim
  // exists to explain against.
  const fixedBaseRate: Partial<Record<OutcomeKey, number>> = {};
  for (const [key, arr] of Object.entries(perKey)) {
    const positives = arr.filter((r) => r.y).length;
    fixedBaseRate[key as OutcomeKey] = positives / arr.length;
  }

  // base_rate / base_rate_fixed (one row per eligible obs/outcome)
  for (const e of obs.values()) {
    const source = await launchSource(e.launchId);
    const k = obsKey(e.chainId, e.token, e.anchor);
    for (const [key, y] of e.labels) {
      // no committed det_v0 forecast for this observation → nothing to compare against
      const cls = refClass.get(`${k}|${key}`) ?? 'uncommitted';
      countExclusion(exclusions, key, 'base_rate', cls);
      countExclusion(exclusions, key, 'base_rate_fixed', cls);
      if (cls !== 'eligible') continue;
      rows.push({
        obsId: k,
        forecaster: 'base_rate',
        outcomeKey: key,
        trigger: e.trigger,
        source,
        prob: round4(trailingBaseRate(key, e.anchor.getTime())),
        label: y,
      });
      rows.push({
        obsId: k,
        forecaster: 'base_rate_fixed',
        outcomeKey: key,
        trigger: e.trigger,
        source,
        prob: round4(fixedBaseRate[key] ?? 0),
        label: y,
      });
    }
  }

  // scanhood / goplus fixed maps — also need a timely fetch, or they carry hindsight
  const features = (
    await prisma.feature.findMany({
      include: { launch: { select: { id: true, source: true } } },
    })
  ).filter((f) => f.scanhoodRaw != null || f.goplusRaw != null);
  for (const f of features) {
    const k = launchAnchor.get(f.launch.id);
    if (!k) continue;
    const e = obs.get(k);
    if (!e) continue;
    const source = f.launch.source;
    const shProbs = scanhoodToProbabilities(f.scanhoodRaw as Record<string, unknown> | null);
    const gpProbs = goplusToProbabilities(f.goplusRaw as Record<string, unknown> | null);
    for (const [key, y] of e.labels) {
      const ref = refClass.get(`${k}|${key}`) ?? 'uncommitted';
      if (shProbs[key] !== undefined) {
        const cls = ref === 'eligible' && !scannerFetchIsTimely(e.anchor, f.scanhoodFetchedAt) ? 'replay' : ref;
        countExclusion(exclusions, key, 'scanhood', cls);
        if (cls === 'eligible') {
          rows.push({ obsId: k, forecaster: 'scanhood', outcomeKey: key, trigger: e.trigger, source, prob: shProbs[key]!, label: y });
        }
      }
      if (gpProbs[key] !== undefined) {
        const cls = ref === 'eligible' && !scannerFetchIsTimely(e.anchor, f.goplusFetchedAt) ? 'replay' : ref;
        countExclusion(exclusions, key, 'goplus', cls);
        if (cls === 'eligible') {
          rows.push({ obsId: k, forecaster: 'goplus', outcomeKey: key, trigger: e.trigger, source, prob: gpProbs[key]!, label: y });
        }
      }
    }
  }

  return { rows, exclusions };
}

const sourceCache = new Map<string, string>();
async function launchSource(launchId: string | null): Promise<string> {
  if (!launchId) return 'unknown';
  const hit = sourceCache.get(launchId);
  if (hit) return hit;
  const l = await prisma.launch.findUnique({ where: { id: launchId }, select: { source: true } });
  const s = l?.source ?? 'unknown';
  sourceCache.set(launchId, s);
  return s;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
