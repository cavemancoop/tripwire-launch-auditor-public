import { existsSync, readFileSync } from 'node:fs';
import {
  GENESIS_HASH,
  prisma,
  verifyLifecycleRows,
  type LifecycleChainRow,
} from '@launch-auditor/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { checkDesignPartner } from './auth';
import { makeAssessEnqueuer, type AssessEnqueuer } from './assess-queue';
import { budgetDisplay } from './budget-display';
import { chainFundingReader, type FundingReader } from './funding';
import { makeDeepdiveEnqueuer, type DeepdiveEnqueuer } from './deepdive-queue';
import { loadApiEnv, type ApiEnv } from './env';
import { prismaLaunchDetailReader, type LaunchDetailReader } from './launch-detail';

export type { LaunchDetailRow, LaunchDetailReader } from './launch-detail';
import { formatPrometheus, prismaMetricsReader, type MetricsReader } from './metrics';
import { mountMcp } from './mcp';
import { verifyProof } from './merkle';
import { prismaReceiptReader, type ReceiptReader } from './receipt';

export type { Receipt, ReceiptReader } from './receipt';

/** One `lifecycle_log` row as served by `GET /v1/lifecycle`. */
export interface LifecycleApiRow extends LifecycleChainRow {
  id: string;
  /** ISO — this is the value folded into `bodyHash`, not a display timestamp */
  at: string;
  signature: string | null;
  keyId: string | null;
  /** M5c — not part of the signed body; exact | aggregate_only | unavailable | anomaly | phantom.
   *  Optional: rows written before M5c have none. */
  billingStatus?: string | null;
}

/** M5c — the agent's cost-forecast error, graded per epoch like any other forecast. */
export interface EstimatorSummary {
  windows: number;
  /** Σ provider deltas over the trailing 24h — the authoritative bill */
  providerSpend24hUsd: number;
  /** Σ local token-priced estimates over the same windows */
  estimatedSpend24hUsd: number;
  requests24h: number;
  /** mean |discrepancy| across windows that had requests */
  meanAbsDiscrepancyPct: number | null;
  latest: {
    at: string;
    billingStatus: string;
    discrepancyPct: number | null;
    reconciliationFactor: number | null;
  } | null;
  /**
   * Where these figures came from, never left implicit:
   *  - `epoch_reconciled` — provider spend reconciled against local estimates
   *    each lifecycle tick. Needs a live Orbio MCP session.
   *  - `local_ledger` — the session is down, so there are no epochs; these are
   *    our own per-request token-priced estimates straight from MetabolismSpend.
   *    Real spend, but unconfirmed against the provider's bill.
   *  - `none` — nothing recorded in the window.
   */
  basis: 'epoch_reconciled' | 'local_ledger' | 'none';
}

export type EstimatorReader = () => Promise<EstimatorSummary>;

const prismaEstimatorReader: EstimatorReader = async () => {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await prisma.metabolismEpoch.findMany({
    where: { at: { gte: since } },
    orderBy: { at: 'desc' },
  });
  const graded = rows.filter((r) => r.discrepancyPct != null);
  const meanAbs =
    graded.length > 0
      ? Math.round((graded.reduce((a, r) => a + Math.abs(r.discrepancyPct!), 0) / graded.length) * 100) / 100
      : null;
  const latest = rows[0] ?? null;

  // Epochs are written by the lifecycle runner, which needs a live Orbio MCP
  // session. Without one there are no epochs — but deep-dives still run and
  // still record their own cost, so reporting zero here would be a visible
  // lie on the panel while the ledger fills up behind it. Fall back to the
  // ledger and say that's what we did.
  if (rows.length === 0) {
    const spend = await prisma.metabolismSpend.aggregate({
      where: { at: { gte: since } },
      _sum: { costUsd: true, estimatedCostUsd: true },
      _count: { _all: true },
    });
    const count = spend._count._all;
    if (count === 0) {
      return {
        windows: 0,
        providerSpend24hUsd: 0,
        estimatedSpend24hUsd: 0,
        requests24h: 0,
        meanAbsDiscrepancyPct: null,
        latest: null,
        basis: 'none',
      };
    }
    const local = spend._sum.estimatedCostUsd ?? spend._sum.costUsd ?? 0;
    return {
      windows: 0,
      providerSpend24hUsd: 0, // unconfirmed: nobody has read the provider's bill
      estimatedSpend24hUsd: Math.round(local * 1e4) / 1e4,
      requests24h: count,
      meanAbsDiscrepancyPct: null,
      latest: null,
      basis: 'local_ledger',
    };
  }

  return {
    windows: rows.length,
    providerSpend24hUsd: Math.round(rows.reduce((a, r) => a + r.providerDeltaUsd, 0) * 1e4) / 1e4,
    estimatedSpend24hUsd: Math.round(rows.reduce((a, r) => a + r.localEstimateUsd, 0) * 1e4) / 1e4,
    requests24h: rows.reduce((a, r) => a + r.requestCount, 0),
    meanAbsDiscrepancyPct: meanAbs,
    latest: latest
      ? {
          at: latest.at.toISOString(),
          billingStatus: latest.billingStatus,
          discrepancyPct: latest.discrepancyPct,
          reconciliationFactor: latest.reconciliationFactor,
        }
      : null,
    basis: 'epoch_reconciled',
  };
};

/** Deep-dive spend since 00:00 UTC — the same window and sources the worker's gate uses. */
export type TodaySpendReader = (now: Date) => Promise<{ ledgerUsd: number; providerUsd: number }>;

const prismaTodaySpendReader: TodaySpendReader = async (now) => {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [ledger, provider] = await Promise.all([
    prisma.metabolismSpend.aggregate({ _sum: { costUsd: true }, where: { at: { gte: dayStart } } }),
    prisma.metabolismEpoch.aggregate({ _sum: { providerDeltaUsd: true }, where: { at: { gte: dayStart } } }),
  ]);
  return { ledgerUsd: ledger._sum.costUsd ?? 0, providerUsd: provider._sum.providerDeltaUsd ?? 0 };
};

export type LifecycleReader = (limit: number) => Promise<LifecycleApiRow[]>;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Default reader: the most-recent `limit` rows, returned oldest → newest. */
const prismaLifecycleReader: LifecycleReader = async (limit) => {
  const rows = await prisma.lifecycleLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows
    .map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      isSnapshot: r.isSnapshot,
      prevState: r.prevState,
      newState: r.newState,
      reason: r.reason,
      keyId: r.keyId,
      keyHashPrefix: r.keyHashPrefix,
      balanceUsd: r.balanceUsd,
      keyRemainingUsd: r.keyRemainingUsd,
      reserveUsd: r.reserveUsd,
      ledgerSpendUsd: r.ledgerSpendUsd,
      providerSpendUsd: r.providerSpendUsd,
      idsMismatch: r.idsMismatch,
      billingStatus: r.billingStatus,
      prevHash: r.prevHash,
      bodyHash: r.bodyHash,
      signature: r.signature,
    }))
    .reverse();
};

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const clampLimit = (n: number, max: number): number => (Number.isFinite(n) ? Math.min(max, Math.max(1, Math.trunc(n))) : 50);

// ── GET /v1/launches ─────────────────────────────────────────────────────

export interface LaunchFeedRow {
  token: string;
  source: string;
  lane: string;
  launchAt: string | null;
  /** block of the pool-creation tx — the feed's sort key */
  launchBlock: string;
  /** internal launch id — breaks ties within one block; part of the page cursor */
  launchId: string;
  detV0: {
    pInsiderExit24h: number | null;
    pDrawdown8024h: number | null;
    pTradingAlive24h: number | null;
    reportHash: string;
  } | null;
  proof: { committed: boolean; txHash?: string | null; committedAt?: string | null };
}

/** Position after which the next page starts: newest-first by (launchBlock, launchId). */
export interface LaunchCursor {
  block: bigint;
  id: string;
}

export type LaunchFeedReader = (limit: number, before?: LaunchCursor) => Promise<LaunchFeedRow[]>;

/** Opaque to clients: base64url of "<launchBlock>:<launchId>". */
export function encodeLaunchCursor(c: LaunchCursor): string {
  return Buffer.from(`${c.block}:${c.id}`).toString('base64url');
}

export function decodeLaunchCursor(s: string): LaunchCursor | null {
  const m = /^(\d{1,20}):([A-Za-z0-9_-]{1,64})$/.exec(Buffer.from(s, 'base64url').toString('utf8'));
  return m ? { block: BigInt(m[1]!), id: m[2]! } : null;
}

const prismaLaunchFeedReader: LaunchFeedReader = async (limit, before) => {
  const launches = await prisma.launch.findMany({
    where: {
      retrospective: false,
      ...(before
        ? { OR: [{ launchBlock: { lt: before.block } }, { launchBlock: before.block, id: { lt: before.id } }] }
        : {}),
    },
    orderBy: [{ launchBlock: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  if (launches.length === 0) return [];

  const tokens = launches.map((l) => l.tokenAddress);
  const detReports = await prisma.report.findMany({
    where: { tokenAddress: { in: tokens }, forecaster: 'det_v0' },
    orderBy: { createdAt: 'desc' },
    include: { commit: { select: { txHash: true, committedAt: true } } },
  });
  const byToken = new Map<string, (typeof detReports)[number]>();
  for (const r of detReports) if (!byToken.has(r.tokenAddress)) byToken.set(r.tokenAddress, r);

  return launches.map((l) => {
    const r = byToken.get(l.tokenAddress);
    return {
      token: l.tokenAddress,
      source: l.source,
      lane: l.lane,
      launchAt: l.launchAt?.toISOString() ?? null,
      launchBlock: l.launchBlock.toString(),
      launchId: l.id,
      detV0: r
        ? {
            pInsiderExit24h: r.pInsiderExit24h,
            pDrawdown8024h: r.pDrawdown80_24h,
            pTradingAlive24h: r.pTradingAlive24h,
            reportHash: r.reportHash,
          }
        : null,
      proof: r?.commit
        ? { committed: true, txHash: r.commit.txHash, committedAt: r.commit.committedAt?.toISOString() ?? null }
        : { committed: false },
    };
  });
};

// ── GET /v1/report/:token ────────────────────────────────────────────────

export interface TokenReportRow {
  token: string;
  reportTime: string;
  forecasters: Array<{
    forecaster: string;
    version: string;
    trigger: string;
    confidence: number | null;
    evidence: unknown;
    probabilities: Record<string, number | null>;
    reportHash: string;
    validatorPassed: boolean;
    proof: { committed: boolean; txHash?: string | null; committedAt?: string | null };
  }>;
}

export type ReportReader = (token: string) => Promise<TokenReportRow | null>;

const prismaReportReader: ReportReader = async (token) => {
  const reports = await prisma.report.findMany({
    where: { tokenAddress: token },
    orderBy: { createdAt: 'desc' },
    take: 50, // every forecaster's forecast for the most recent one or two report times
    include: { commit: { select: { txHash: true, committedAt: true } } },
  });
  if (reports.length === 0) return null;

  const latestTime = reports[0]!.reportTime.getTime();
  const atLatest = reports.filter((r) => r.reportTime.getTime() === latestTime);

  return {
    token,
    reportTime: reports[0]!.reportTime.toISOString(),
    forecasters: atLatest.map((r) => ({
      forecaster: r.forecaster,
      version: r.forecasterVersion,
      trigger: r.trigger,
      confidence: r.confidence,
      evidence: r.evidence,
      probabilities: {
        insiderExit6h: r.pInsiderExit6h,
        insiderExit24h: r.pInsiderExit24h,
        insiderExit72h: r.pInsiderExit72h,
        sellImpaired1h: r.pSellImpaired1h,
        sellImpaired24h: r.pSellImpaired24h,
        liqImpaired24h: r.pLiqImpaired24h,
        liqImpaired7d: r.pLiqImpaired7d,
        drawdown8024h: r.pDrawdown80_24h,
        drawdown807d: r.pDrawdown80_7d,
        tradingAlive24h: r.pTradingAlive24h,
        tradingAlive7d: r.pTradingAlive7d,
      },
      reportHash: r.reportHash,
      validatorPassed: r.validatorPassed,
      proof: r.commit
        ? { committed: true, txHash: r.commit.txHash, committedAt: r.commit.committedAt?.toISOString() ?? null }
        : { committed: false },
    })),
  };
};

// ── GET /v1/benchmark ────────────────────────────────────────────────────
// The worker recomputes the benchmark every 5 minutes; the API only reads
// the latest snapshot, never scores anything itself. M9: read from Postgres
// (shared by every deployment topology, single-machine fork-and-run or
// separate Railway services) rather than the local file the worker also
// still writes — the file was only ever a shared filesystem's worth of
// transport, and Railway's api/worker don't share one.

export type BenchmarkReader = () => Promise<unknown | null>;

export const prismaBenchmarkReader: BenchmarkReader = async () => {
  const row = await prisma.benchmarkSnapshot.findUnique({ where: { key: 'latest' } });
  return row?.json ?? null;
};

/** Kept for local/offline use (e.g. reading a `scorer:run --out` file directly). */
export const fileBenchmarkReader = (path: string): BenchmarkReader => async () => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// ── GET /v1/proof/:hash ──────────────────────────────────────────────────

interface StoredLeaf {
  reportHash: string;
  index: number;
  proof: string[];
}

export interface ProofRow {
  reportHash: string;
  committed: boolean;
  proofAvailable?: boolean;
  proofValid?: boolean;
  merkleRoot?: string;
  leafIndex?: number;
  proof?: string[];
  txHash?: string | null;
  blockNumber?: number | null;
  /** true/false = confirmed on-chain; null = RPC couldn't confirm right now (never reported as false) */
  onChainConfirmed?: boolean | null;
}

export type ProofReader = (hash: string) => Promise<ProofRow | null>;

const BATCH_COMMITTED_EVENT = parseAbiItem(
  'event BatchCommitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 leafCount, uint256 timestamp)',
);

const prismaProofReader = (env: ApiEnv): ProofReader => async (hash) => {
  const report = await prisma.report.findUnique({ where: { reportHash: hash }, include: { commit: true } });
  if (!report) return null;
  if (!report.commit) return { reportHash: hash, committed: false };

  const commit = report.commit;
  const leaves = (commit.leaves as unknown as StoredLeaf[]) ?? [];
  const leaf = leaves.find((l) => l.reportHash.toLowerCase() === hash);
  if (!leaf) return { reportHash: hash, committed: true, proofAvailable: false };

  const proofValid = verifyProof(hash as Hex, leaf.proof as Hex[], commit.merkleRoot as Hex);

  let onChainConfirmed: boolean | null = null;
  if (env.commitRegistryAddress && commit.blockNumber != null && env.rpcUrl) {
    try {
      const client = createPublicClient({ transport: http(env.rpcUrl) });
      const logs = await client.getLogs({
        address: env.commitRegistryAddress,
        event: BATCH_COMMITTED_EVENT,
        fromBlock: commit.blockNumber,
        toBlock: commit.blockNumber,
      });
      onChainConfirmed = logs.some(
        (l) => (l.args.merkleRoot as string | undefined)?.toLowerCase() === commit.merkleRoot.toLowerCase(),
      );
    } catch {
      onChainConfirmed = null; // an RPC hiccup is "unknown", never reported as "not confirmed"
    }
  }

  return {
    reportHash: hash,
    committed: true,
    proofAvailable: true,
    proofValid,
    merkleRoot: commit.merkleRoot,
    leafIndex: leaf.index,
    proof: leaf.proof,
    txHash: commit.txHash,
    blockNumber: commit.blockNumber != null ? Number(commit.blockNumber) : null,
    onChainConfirmed,
  };
};

export interface BuildServerOptions {
  /** injectable for tests — defaults to a Prisma-backed reader */
  lifecycleReader?: LifecycleReader;
  estimatorReader?: EstimatorReader;
  todaySpendReader?: TodaySpendReader;
  launchFeedReader?: LaunchFeedReader;
  reportReader?: ReportReader;
  launchDetailReader?: LaunchDetailReader;
  benchmarkReader?: BenchmarkReader;
  proofReader?: ProofReader;
  receiptReader?: ReceiptReader;
  metricsReader?: MetricsReader;
  fundingReader?: FundingReader;
  /** injectable for tests — defaults to a BullMQ producer on the `deepdive` queue */
  enqueueDeepdive?: DeepdiveEnqueuer;
  /** injectable for tests — defaults to a BullMQ producer on the `assess` queue */
  enqueueAssess?: AssessEnqueuer;
  env?: ApiEnv;
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const env = opts.env ?? loadApiEnv();

  const readLifecycle = opts.lifecycleReader ?? prismaLifecycleReader;
  const readEstimator = opts.estimatorReader ?? prismaEstimatorReader;
  const readTodaySpend = opts.todaySpendReader ?? prismaTodaySpendReader;
  const readLaunchFeed = opts.launchFeedReader ?? prismaLaunchFeedReader;
  const readReport = opts.reportReader ?? prismaReportReader;
  const readLaunchDetail = opts.launchDetailReader ?? prismaLaunchDetailReader;
  const readBenchmark = opts.benchmarkReader ?? prismaBenchmarkReader;
  const readProof = opts.proofReader ?? prismaProofReader(env);
  const readReceipt = opts.receiptReader ?? prismaReceiptReader(env);
  const readMetrics = opts.metricsReader ?? prismaMetricsReader;
  const readFunding = opts.fundingReader ?? chainFundingReader(env);

  let enqueueDeepdive = opts.enqueueDeepdive;
  const getEnqueueDeepdive = (): DeepdiveEnqueuer => (enqueueDeepdive ??= makeDeepdiveEnqueuer());
  let enqueueAssess = opts.enqueueAssess;
  const getEnqueueAssess = (): AssessEnqueuer => (enqueueAssess ??= makeAssessEnqueuer());

  // M8 — the dashboard (apps/web) is served from its own port and reads these
  // endpoints client-side. Everything here is public read data (or free,
  // rate-unlimited writes during the contest — spec §9), so a wildcard is the
  // honest CORS policy: no cookies, no credentials, nothing origin-scoped.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key');
    if (req.method === 'OPTIONS') reply.code(204).send();
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'launch-auditor-api',
  }));

  // M9 — Prometheus text exposition; also the source for the Telegram
  // alert loop's four checks (apps/worker/src/alerts.ts queries Postgres
  // directly, so this route and that loop can never disagree by construction).
  app.get('/metrics', async (_req, reply) => {
    const m = await readMetrics();
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return formatPrometheus(m);
  });

  // spec §9 — free: the live feed, newest first, with each launch's latest
  // det_v0 forecast and commit pointer. Paged with an opaque cursor so a third
  // party can walk the whole live corpus, not just the newest 200 (19 Sep
  // audit): follow `nextCursor` via `?before=` until it is null.
  app.get('/v1/launches', async (req, reply) => {
    const q = req.query as { limit?: string; before?: string };
    const limit = clampLimit(Number(q.limit ?? 50), 200);
    let before: LaunchCursor | undefined;
    if (q.before) {
      const c = decodeLaunchCursor(q.before);
      if (!c) return reply.code(400).send({ error: 'before must be a nextCursor from a previous page' });
      before = c;
    }
    const launches = await readLaunchFeed(limit, before);
    const last = launches[launches.length - 1];
    const nextCursor =
      launches.length === limit && last ? encodeLaunchCursor({ block: BigInt(last.launchBlock), id: last.launchId }) : null;
    return { count: launches.length, launches, nextCursor };
  });

  // spec §9 — free tier during the contest: every forecaster's latest
  // forecast for this token, with evidence and proof status.
  app.get('/v1/report/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!HEX_ADDR.test(token)) {
      return reply.code(400).send({ error: 'token must be a 20-byte hex address' });
    }
    const row = await readReport(token.toLowerCase());
    if (!row) return reply.code(404).send({ error: 'no report for this token yet' });
    return row;
  });

  // Codex Phase A #2 / Phase B #2 — free: everything the scorer itself reads
  // for one token (primary-pool evidence, the raw feature vector +
  // provenance, every outcome row with its evidence/coverage), so the
  // published benchmark can be reproduced from public data, not just
  // asserted. `/v1/report` has the forecasts; this has their inputs.
  app.get('/v1/launch/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!HEX_ADDR.test(token)) {
      return reply.code(400).send({ error: 'token must be a 20-byte hex address' });
    }
    const row = await readLaunchDetail(token.toLowerCase());
    if (!row) return reply.code(404).send({ error: 'no launch for this token' });
    return row;
  });

  // spec §9 — free during the contest: on-demand report for a token of any
  // age. Enqueued to the worker (same pattern as /v1/deepdive), which owns
  // chain access and report signing. NOTE (scope): this produces one
  // immediate report; "daily re-scores for 7 days" is the recurring,
  // event-aware re-scoring layer (v0.3 Watch, spec §10.1) and is not built.
  app.post('/v1/assess/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!HEX_ADDR.test(token)) {
      return reply.code(400).send({ error: 'token must be a 20-byte hex address' });
    }
    const auth = checkDesignPartner(req.headers['x-api-key'] as string | undefined, env.designPartnerApiKeys);
    try {
      const { id } = await getEnqueueAssess()({ tokenAddress: token.toLowerCase() });
      return reply.code(202).send({
        queued: true,
        token: token.toLowerCase(),
        jobId: id ?? null,
        designPartner: auth.designPartner,
        note: 'one immediate on-demand report; recurring re-scores are roadmap (v0.3 Watch), not built yet',
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'could not enqueue the assessment' });
    }
  });

  // spec §9 — `POST /v1/deepdive/{token}`: enqueue an on-demand
  // `llm_deepdive_v0` run. x402 gating is deferred (spec §9), but this spends
  // the agent's own Orbio balance per call — 2026-09-16, once that balance held
  // real money, an unauthenticated caller could exhaust the daily cap. Requires
  // the same `x-api-key` design partners already send; `/v1/assess` stays free
  // (det_v0/heuristic only, no LLM spend).
  app.post('/v1/deepdive/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!HEX_ADDR.test(token)) {
      return reply.code(400).send({ error: 'token must be a 20-byte hex address' });
    }
    const auth = checkDesignPartner(req.headers['x-api-key'] as string | undefined, env.designPartnerApiKeys);
    if (!auth.designPartner) {
      return reply.code(401).send({ error: 'x-api-key required for /v1/deepdive — this spends the agent\'s Orbio balance' });
    }
    try {
      const { id } = await getEnqueueDeepdive()({ tokenAddress: token.toLowerCase(), trigger: 'on_demand' });
      return reply
        .code(202)
        .send({ queued: true, token: token.toLowerCase(), jobId: id ?? null, designPartner: auth.designPartner });
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'could not enqueue the deep-dive' });
    }
  });

  // spec §9 — free: metrics table, all forecasters, sample sizes.
  app.get('/v1/benchmark', async (_req, reply) => {
    const b = await readBenchmark();
    if (!b) {
      return reply
        .code(503)
        .send({ error: 'benchmark not yet computed — the worker writes a snapshot every 5 minutes' });
    }
    return b;
  });

  // spec §9 — free: an independently verifiable Merkle proof for a report
  // hash, plus (best-effort) confirmation that its batch root is on-chain.
  // 2026-09-16 — every CREDIT activation into the agent's Orbio account, from
  // chain 4663: who funded the inference, how much, and the tx to check it.
  app.get('/v1/funding', async (_req, reply) => {
    try {
      return await readFunding();
    } catch (err) {
      return reply.code(503).send({ error: 'funding read failed', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/v1/proof/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!HEX_HASH.test(hash)) {
      return reply.code(400).send({ error: 'hash must be a 32-byte hex value' });
    }
    const row = await readProof(hash.toLowerCase());
    if (!row) return reply.code(404).send({ error: 'unknown report hash' });
    return row;
  });

  // 2026-09-19 audit fix 3 — free: one forecast provable end to end. The exact
  // canonical bytes that were hashed, the EIP-712 signature over that hash,
  // the Merkle proof, the commit's chain block time, and each outcome for the
  // same anchor with its eligibility. `pnpm verify:receipt <hash>` checks it
  // without trusting this server.
  app.get('/v1/receipt/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!HEX_HASH.test(hash)) {
      return reply.code(400).send({ error: 'hash must be a 32-byte hex value' });
    }
    const receipt = await readReceipt(hash.toLowerCase());
    if (!receipt) return reply.code(404).send({ error: 'unknown report hash' });
    return receipt;
  });

  // spec §9 — free: the signed key-lifecycle log (spec §8), plus (M5c) the
  // metabolism's own cost-forecast error over the trailing 24h — graded like
  // any other forecaster. Each entry is independently verifiable:
  // `bodyHash` = keccak256(RFC-8785(body)), `signature` = the agent key's
  // EIP-191 personal_sign of `bodyHash`, `prevHash` folds the previous
  // entry's `bodyHash` into a tamper-evident chain.
  app.get('/v1/lifecycle', async (req) => {
    const q = req.query as { limit?: string };
    const parsed = Number(q.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(parsed)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
      : DEFAULT_LIMIT;

    const [entries, estimator, funding, today] = await Promise.all([
      readLifecycle(limit),
      readEstimator(),
      // property 2 (2026-09-16): same cached on-chain read /v1/funding uses.
      // A failure here must not take the whole lifecycle endpoint down — the
      // display then reports the flat-cap fallback, as the worker does.
      readFunding().catch(() => null),
      readTodaySpend(new Date()),
    ]);
    const check = verifyLifecycleRows(entries);

    // the worker reads the latest snapshot with a balance, not the latest row
    const withBalance = [...entries].reverse().find((e) => e.balanceUsd != null);
    const latest = entries[entries.length - 1];
    const budget = budgetDisplay({
      dailyCapUsd: env.deepdiveDailyCapUsd,
      capPerRunUsd: env.deepdiveCapPerRunUsd,
      trailingCreditsUsd: funding?.configured ? funding.trailingCreditsUsd : undefined,
      todaySpendUsd: today.ledgerUsd,
      providerSpendTodayUsd: today.providerUsd,
      // null, not 0, when no balance has ever been read: the worker falls back
      // to the daily cap in that case and keeps running.
      balanceUsd: withBalance?.balanceUsd ?? null,
      reserveUsd: env.metabolismReserveUsd,
      billingStatus: withBalance?.billingStatus ?? latest?.billingStatus ?? estimator.latest?.billingStatus ?? null,
    });

    return {
      count: entries.length,
      limit,
      genesisHash: GENESIS_HASH,
      // verified = no row altered and no missing parent. Forks (two signed rows
      // sharing a parent, from two writers during a deploy overlap) are listed,
      // not hidden, and `linear` says whether the window is a single chain.
      verified: check.intact,
      linear: check.linked,
      forks: check.forks,
      startsAtGenesis: check.startsAtGenesis,
      brokenAt: check.brokenAt,
      entries,
      estimator,
      budget,
      verification: {
        body: 'keccak256(RFC8785({at,prevState,newState,reason,isSnapshot,keyHashPrefix,balanceUsd,keyRemainingUsd,reserveUsd,ledgerSpendUsd,providerSpendUsd,idsMismatch,prevHash}))',
        signature: 'agent key EIP-191 personal_sign of bodyHash (raw 32 bytes)',
        chain: 'entries[i].prevHash === entries[i-1].bodyHash; entries[0].prevHash === genesisHash',
      },
    };
  });

  // spec §9 — MCP server: get_report, get_benchmark, request_deepdive so an
  // agent buyer needs no HTTP client code.
  mountMcp(app, {
    readReport,
    readBenchmark,
    enqueueDeepdive: getEnqueueDeepdive,
    enqueueAssess: getEnqueueAssess,
    designPartnerApiKeys: env.designPartnerApiKeys,
  });

  return app;
}
