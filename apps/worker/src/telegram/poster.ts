/**
 * M8 — free feed: post each qualified launch's det_v0 summary + proof link to
 * a Telegram channel once its report has a commit (so the proof link
 * resolves). `telegramPostedAt` on the report row is the dedupe guard: a
 * restart never re-posts a report it already sent.
 *
 * M12b — the feed publishes only what the benchmark supports: det_v0 ranks
 * better than both base rates on insider exit (24h) and still trading (24h),
 * and its probabilities are miscalibrated on every cell. So each post shows a
 * rank tier on those two cells (drawdown ranks backwards and is not posted),
 * never a raw probability.
 */
import { getChainConfig } from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import { recordFailure } from '../failures';
import type { StopSignal } from '../watcher/poller';

export interface TelegramCandidateRow {
  id: string;
  tokenAddress: string;
  reportHash: string;
  reportTime: Date;
  pInsiderExit24h: number | null;
  pTradingAlive24h: number | null;
  txHash: string | null;
  committedAt: Date | null;
}

/** det_v0 scores of the qualified launches a report is ranked against. */
export interface PeerScores {
  insiderExit24h: number[];
  tradingAlive24h: number[];
}

export type CandidateReader = (limit: number) => Promise<TelegramCandidateRow[]>;
export type PeerReader = (reportTime: Date) => Promise<PeerScores>;
export type MarkPosted = (reportId: string) => Promise<void>;
export type TelegramSender = (text: string) => Promise<void>;

/** fewer peers than this and a tier would be too coarse to mean anything */
export const MIN_PEERS = 20;
/** a report committed later than this after its anchor is not "new", and its window is already partly observed */
export const MAX_COMMIT_LAG_MS = 30 * 60_000;
/** only reports anchored this recently are candidates, so skipped stale ones age out instead of blocking the queue */
const CANDIDATE_WINDOW_MS = 60 * 60_000;
const PEER_WINDOW_MS = 24 * 3_600_000;

/** Qualified-lane, committed, not-yet-posted det_v0 reports anchored in the last hour, oldest first. */
const prismaCandidateReader: CandidateReader = async (limit) => {
  const reports = await prisma.report.findMany({
    where: {
      forecaster: 'det_v0',
      retrospective: false,
      telegramPostedAt: null,
      commitId: { not: null },
      reportTime: { gte: new Date(Date.now() - CANDIDATE_WINDOW_MS) },
      launch: { lane: 'qualified', retrospective: false },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { commit: { select: { txHash: true, committedAt: true } } },
  });
  return reports.map((r) => ({
    id: r.id,
    tokenAddress: r.tokenAddress,
    reportHash: r.reportHash,
    reportTime: r.reportTime,
    pInsiderExit24h: r.pInsiderExit24h,
    pTradingAlive24h: r.pTradingAlive24h,
    txHash: r.commit?.txHash ?? null,
    committedAt: r.commit?.committedAt ?? null,
  }));
};

/** det_v0 scores of qualified launches anchored in the 24h before `reportTime` (the report itself excluded). */
const prismaPeerReader: PeerReader = async (reportTime) => {
  const peers = await prisma.report.findMany({
    where: {
      forecaster: 'det_v0',
      retrospective: false,
      reportTime: { gte: new Date(reportTime.getTime() - PEER_WINDOW_MS), lt: reportTime },
      launch: { lane: 'qualified', retrospective: false },
    },
    select: { pInsiderExit24h: true, pTradingAlive24h: true },
  });
  return {
    insiderExit24h: peers.map((p) => p.pInsiderExit24h).filter((v): v is number => v != null),
    tradingAlive24h: peers.map((p) => p.pTradingAlive24h).filter((v): v is number => v != null),
  };
};

const prismaMarkPosted: MarkPosted = async (id) => {
  await prisma.report.update({ where: { id }, data: { telegramPostedAt: new Date() } });
};

export type Tier = 'top10' | 'top25' | 'middle' | 'bottom25';

/**
 * Where `value` falls among `peers`, as the share of peers it scores above
 * (ties count half). Null when there are too few peers to rank against.
 */
export function rankTier(value: number | null, peers: number[]): Tier | null {
  if (value == null || peers.length < MIN_PEERS) return null;
  let below = 0;
  let equal = 0;
  for (const p of peers) {
    if (p < value) below += 1;
    else if (p === value) equal += 1;
  }
  const share = (below + equal / 2) / peers.length;
  if (share >= 0.9) return 'top10';
  if (share >= 0.75) return 'top25';
  if (share >= 0.25) return 'middle';
  return 'bottom25';
}

const INSIDER_LABEL: Record<Tier, string> = {
  top10: 'top 10% riskiest',
  top25: 'top 25% riskiest',
  middle: 'middle half',
  bottom25: 'bottom 25% (least risky)',
};
const ALIVE_LABEL: Record<Tier, string> = {
  top10: 'top 10% most likely',
  top25: 'top 25% most likely',
  middle: 'middle half',
  bottom25: 'bottom 25% (least likely)',
};

/** Posted only when the batch committed soon after the report's T+10m anchor. */
export function isFresh(row: TelegramCandidateRow): boolean {
  return row.committedAt != null && row.committedAt.getTime() - row.reportTime.getTime() <= MAX_COMMIT_LAG_MS;
}

/**
 * Commits are Merkle-batched (spec §6): one root per batch of report hashes
 * every 5 minutes, so every launch in a batch shares one transaction. Correct,
 * but linking only the tx made consecutive posts all point at the same hash —
 * which reads like a bug to anyone who doesn't know the design. Lead with the
 * per-report verify link, which proves *this* forecast against that root, and
 * label the tx as the batch anchor it is.
 */
export function formatTelegramMessage(
  row: TelegramCandidateRow,
  peers: PeerScores,
  chainId: number,
  apiBase?: string,
): string {
  const explorer = getChainConfig(chainId).explorer;
  const api = apiBase?.replace(/\/$/, '');
  const insider = rankTier(row.pInsiderExit24h, peers.insiderExit24h);
  const alive = rankTier(row.pTradingAlive24h, peers.tradingAlive24h);
  const peerCount = Math.max(peers.insiderExit24h.length, peers.tradingAlive24h.length);

  const lines = [`New qualified launch: ${row.tokenAddress}`];
  if (insider || alive) {
    lines.push(`Insider exit within 24h: ${insider ? INSIDER_LABEL[insider] : 'not ranked'}`);
    lines.push(`Still trading at 24h: ${alive ? ALIVE_LABEL[alive] : 'not ranked'}`);
    lines.push(`Ranked against the ${peerCount} qualified launches in the previous 24h.`);
  } else {
    lines.push(`Not ranked: fewer than ${MIN_PEERS} qualified launches in the previous 24h to compare against.`);
  }
  lines.push(
    `Ranking only: these scores are not calibrated probabilities. Benchmark: ${api ? `${api}/v1/benchmark` : 'see the dashboard'}`,
  );
  // the receipt proves *this* forecast's signed bytes, not just batch membership
  if (api) lines.push(`Verify this forecast: ${api}/v1/receipt/${row.reportHash}`);
  lines.push(
    row.txHash
      ? `Batch anchor (many reports, one Merkle root): ${explorer}/tx/${row.txHash}`
      : 'Proof: pending next commit batch',
  );
  lines.push(`Report hash: ${row.reportHash}`);
  if (row.committedAt) {
    const lagMin = Math.max(0, Math.round((row.committedAt.getTime() - row.reportTime.getTime()) / 60_000));
    lines.push(`Committed ${lagMin} min after its T+10m anchor · reproducible scorer`);
  }
  return lines.join('\n');
}

export function makeTelegramSender(botToken: string, chatId: string): TelegramSender {
  return async (text) => {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`telegram sendMessage ${res.status}: ${body.slice(0, 200)}`);
    }
  };
}

export interface PosterDeps {
  chainId: number;
  /** public API base, so each post can link its own verifiable proof */
  apiBase?: string;
  send: TelegramSender;
  readCandidates?: CandidateReader;
  readPeers?: PeerReader;
  markPosted?: MarkPosted;
  limit?: number;
}

export interface PosterSweepResult {
  candidates: number;
  /** committed too long after their anchor — never posted, and they age out of the candidate window */
  stale: number;
  posted: number;
  failed: number;
}

/**
 * One sweep: post up to `limit` fresh, unposted qualified-launch reports,
 * oldest first. A send failure is logged and left unmarked so the next sweep
 * retries it — it never counts as posted and never blocks the rest.
 */
export async function postQualifiedLaunches(deps: PosterDeps): Promise<PosterSweepResult> {
  const readCandidates = deps.readCandidates ?? prismaCandidateReader;
  const readPeers = deps.readPeers ?? prismaPeerReader;
  const markPosted = deps.markPosted ?? prismaMarkPosted;
  const limit = deps.limit ?? 5;

  const all = await readCandidates(limit * 10);
  const fresh = all.filter(isFresh);
  const rows = fresh.slice(0, limit);
  let posted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const peers = await readPeers(row.reportTime);
      await deps.send(formatTelegramMessage(row, peers, deps.chainId, deps.apiBase));
      await markPosted(row.id);
      posted += 1;
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`[telegram] post failed for ${row.tokenAddress}:`, err instanceof Error ? err.message : err);
      await recordFailure('telegram.post_failed', err);
    }
  }
  return { candidates: all.length, stale: all.length - fresh.length, posted, failed };
}

export interface TelegramPosterLoopOptions {
  botToken: string;
  chatId: string;
  chainId: number;
  apiBase?: string;
  intervalMs?: number;
  limit?: number;
}

export async function runTelegramPosterLoop(
  signal: StopSignal,
  opts: TelegramPosterLoopOptions,
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 30_000;
  const send = makeTelegramSender(opts.botToken, opts.chatId);
  // eslint-disable-next-line no-console
  console.log(`[telegram] free-feed poster every ${intervalMs / 1000}s -> chat ${opts.chatId}`);
  while (!signal.stopped) {
    try {
      const r = await postQualifiedLaunches({ chainId: opts.chainId, send, limit: opts.limit, apiBase: opts.apiBase });
      if (r.candidates > 0) {
        // eslint-disable-next-line no-console
        console.log(`[telegram] swept ${r.candidates}: ${r.posted} posted · ${r.stale} stale · ${r.failed} failed`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[telegram] sweep error', err instanceof Error ? err.message : err);
      await recordFailure('telegram.sweep_error', err);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
