import { Prisma, prisma, type $Enums } from '@launch-auditor/db';
import { recordFailure } from '../failures';
import { DeadlineError, withDeadline } from '../watcher/retry';
import { resolveOneOutcome, type OutcomeRow, type ResolveClient } from './resolve';

/** one outcome should never take longer than this; on timeout it stays PENDING
 *  for the next sweep (guards the backfill against a runaway scan) */
const OUTCOME_DEADLINE_MS = 120_000;

export interface SweepResult {
  picked: number;
  resolved: number;
  na: number;
  unresolvable: number;
  retryLater: number;
  failed: number;
}

/** A deferred row is not picked again for this long. Without it, the oldest
 *  horizon-due rows that fail on RPC errors were re-picked every minute and took
 *  24 of 25 sweep slots, so ~1 outcome resolved per minute (2026-09-15). */
export const DEFAULT_RETRY_BACKOFF_MS = 30 * 60_000;
/** A row still failing on a transient error this long after its FIRST deferral
 *  becomes UNRESOLVABLE ("failed measurements are unresolvable, never an
 *  outcome", OUTCOME_RULES_v1). Measured from first deferral, not horizon, so
 *  the backfill's long-past horizons are not given up on at the first error. */
export const DEFAULT_GIVE_UP_AFTER_MS = 24 * 3_600_000;

export const ALL_OUTCOME_LABELS: $Enums.OutcomeLabel[] = [
  'INSIDER_EXIT',
  'SELL_IMPAIRED',
  'LIQ_IMPAIRED',
  'DRAWDOWN_80',
  'TRADING_ALIVE',
];

/** Pure: round-robin across per-label queues so no single label's backlog takes every slot. */
export function interleave<T>(groups: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let took = false;
    for (const g of groups) {
      if (i < g.length) {
        out.push(g[i]!);
        took = true;
        if (out.length >= limit) break;
      }
    }
    if (!took) break;
  }
  return out;
}

/** Pure: keep retrying a transient failure, or give up and record it as unresolvable. */
export function deferOrGiveUp(
  firstDeferredAt: string | null | undefined,
  now: number,
  giveUpAfterMs: number = DEFAULT_GIVE_UP_AFTER_MS,
): { action: 'defer' | 'give_up'; firstDeferredAt: string } {
  const first =
    firstDeferredAt && !Number.isNaN(Date.parse(firstDeferredAt)) ? firstDeferredAt : new Date(now).toISOString();
  return { action: now - Date.parse(first) >= giveUpAfterMs ? 'give_up' : 'defer', firstDeferredAt: first };
}

/** treat as transient and leave PENDING for the next sweep */
const RETRYABLE =
  /network|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|429|rate.?limit|too many requests|request limit|network is busy|-32005|-32097|capacity|throttl|sweep error/i;

export interface SweepFilter {
  /** only resolve DRAWDOWN_80 + outcomes whose launch reached the qualified lane
   *  (checkpoint §C step 4: the heavy scans run on qualified launches only) */
  qualifiedOnly?: boolean;
  /** resolve this many outcomes at once. The shared RPC scheduler (token bucket)
   *  is the real rate limit, so concurrency just stops the loop being
   *  latency-bound — each outcome is ~80 sequential getLogs. Default 1 (the live
   *  worker loop); the backfill passes 8+. */
  concurrency?: number;
  /** restrict to these outcome labels (base-rate backfill: fill one sparse cell
   *  at a time instead of letting the oldest-horizon cell hog the run) */
  onlyLabels?: $Enums.OutcomeLabel[];
  /** skip these labels (e.g. deprioritise the slow INSIDER_EXIT@6h cell so the
   *  72h / 7d / TRADING_ALIVE cells get reached) */
  excludeLabels?: $Enums.OutcomeLabel[];
  /** oldest-horizon-first (default), a spread across cells via id order, or
   *  `fair`: oldest-first within each label, round-robin across labels */
  order?: 'horizon' | 'spread' | 'fair';
  /** skip rows deferred more recently than this (default 30 min) */
  retryBackoffMs?: number;
  /** transient failures this long after first deferral become UNRESOLVABLE (default 24h) */
  giveUpAfterMs?: number;
  /** only outcomes whose launch reached the qualified lane — for ALL labels,
   *  not just the heavy ones. ~87% of retrospective launches are non-qualified
   *  spam / token-vs-token / >10%-fee side pools whose DRAWDOWN/TRADING_ALIVE
   *  outcomes are unresolvable and would bias the base rate. */
  laneQualifiedOnly?: boolean;
}

/** Resolve every PENDING outcome whose horizon has passed, up to `limit`. */
export async function sweepDueOutcomes(
  client: ResolveClient,
  limit = 25,
  filter: SweepFilter = {},
): Promise<SweepResult> {
  const now = new Date();
  const retryCutoff = new Date(now.getTime() - (filter.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS));
  const giveUpAfterMs = filter.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS;
  const where = {
      status: 'PENDING' as const,
      horizonAt: { lte: now },
      // a deferral stamps measuredAt on a still-PENDING row; wait out the backoff
      AND: [{ OR: [{ measuredAt: null }, { measuredAt: { lt: retryCutoff } }] }],
      ...(filter.onlyLabels?.length ? { label: { in: filter.onlyLabels } } : {}),
      ...(filter.excludeLabels?.length ? { label: { notIn: filter.excludeLabels } } : {}),
      ...(filter.laneQualifiedOnly
        ? { launch: { lane: 'qualified' as const } }
        : filter.qualifiedOnly
          ? {
              OR: [
                { label: 'DRAWDOWN_80' as const },
                { label: 'TRADING_ALIVE' as const }, // both apply to every launch
                { launch: { lane: 'qualified' as const } },
              ],
            }
          : {}),
  };

  let due;
  if (filter.order === 'fair') {
    const labels = (filter.onlyLabels?.length ? filter.onlyLabels : ALL_OUTCOME_LABELS).filter(
      (l) => !filter.excludeLabels?.includes(l),
    );
    const groups = await Promise.all(
      labels.map((label) =>
        prisma.outcome.findMany({
          where: { ...where, label },
          orderBy: { horizonAt: 'asc' },
          take: limit,
        }),
      ),
    );
    due = interleave(groups, limit);
  } else {
    due = await prisma.outcome.findMany({
      where,
      orderBy: filter.order === 'spread' ? { id: 'asc' } : { horizonAt: 'asc' },
      take: limit,
    });
  }

  const out: SweepResult = {
    picked: due.length,
    resolved: 0,
    na: 0,
    unresolvable: 0,
    retryLater: 0,
    failed: 0,
  };

  const deferRow = async (row: (typeof due)[number], label: string, msg: string) => {
    const prior = (row.evidence ?? {}) as { firstDeferredAt?: string; deferrals?: number };
    const d = deferOrGiveUp(prior.firstDeferredAt, Date.now(), giveUpAfterMs);
    const deferrals = (prior.deferrals ?? 0) + 1;
    if (d.action === 'give_up') {
      out.unresolvable++;
      await prisma.outcome.update({
        where: { id: row.id },
        data: {
          status: 'UNRESOLVABLE',
          value: null,
          evidence: {
            reason: `gave up after ${deferrals} transient failures since ${d.firstDeferredAt}: ${msg}`,
            firstDeferredAt: d.firstDeferredAt,
            deferrals,
          } as Prisma.InputJsonValue,
          measuredAt: new Date(),
        },
      });
      // eslint-disable-next-line no-console
      console.warn(`[outcomes] ${label} ${row.tokenAddress} gave up (unresolvable) after ${deferrals} deferrals: ${msg}`);
      return;
    }
    out.retryLater++;
    await prisma.outcome.update({
      where: { id: row.id },
      // stay PENDING; measuredAt starts the backoff, evidence carries the give-up clock
      data: {
        measuredAt: new Date(),
        evidence: { firstDeferredAt: d.firstDeferredAt, deferrals, lastError: msg.slice(0, 300) } as Prisma.InputJsonValue,
      },
    });
    // eslint-disable-next-line no-console
    console.warn(`[outcomes] ${label} ${row.tokenAddress} deferred (${deferrals}): ${msg}`);
  };

  const resolveRow = async (row: (typeof due)[number]): Promise<void> => {
    try {
      const res = await withDeadline(
        () => resolveOneOutcome(client, row as OutcomeRow),
        OUTCOME_DEADLINE_MS,
        `${row.label}@${row.horizon} ${row.tokenAddress}`,
      );

      if (res.status === 'UNRESOLVABLE' && res.reason && RETRYABLE.test(res.reason)) {
        // the classified reason decides retryability; the raw RPC message is only for the log
        const raw = (res.evidence as { rpcError?: string } | undefined)?.rpcError;
        await deferRow(row, `${row.label}@${row.horizon}`, raw ? `${res.reason} — ${raw}` : res.reason);
        return;
      }

      const status = res.status as $Enums.OutcomeStatus;
      await prisma.outcome.update({
        where: { id: row.id },
        data: {
          status,
          value: res.value,
          evidence: {
            ...(res.reason ? { reason: res.reason } : {}),
            ...res.evidence,
          } as unknown as Prisma.InputJsonValue,
          coverage: res.coverage
            ? (res.coverage as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          measuredAt: new Date(),
        },
      });

      if (status === 'RESOLVED') out.resolved++;
      else if (status === 'NA') out.na++;
      else out.unresolvable++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DeadlineError || RETRYABLE.test(msg)) {
        await deferRow(row, `${row.label}@${row.horizon}`, msg);
        return;
      }
      out.failed++;
      // back off a code-path failure too, or it takes a slot every sweep forever; never give up on it
      await prisma.outcome
        .update({ where: { id: row.id }, data: { measuredAt: new Date() } })
        .catch(() => {});
      // eslint-disable-next-line no-console
      console.error(
        `[outcomes] ${row.label}@${row.horizon} ${row.tokenAddress} failed:`,
        err instanceof Error ? err.message : err,
      );
      await recordFailure('outcomes.resolve_failed', err);
    }
  };

  const concurrency = Math.max(1, filter.concurrency ?? 1);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, due.length) }, async () => {
    while (cursor < due.length) {
      const row = due[cursor++]!;
      await resolveRow(row);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface OutcomesLoopOptions {
  intervalMs?: number;
  batch?: number;
  /** outcomes resolved in parallel per sweep. The shared RPC token bucket (watcher >
   *  commit > outcomes) is the real rate limit, so this only stops the loop being
   *  latency-bound: at 1, one sweep of 25 took ~5 min (2026-09-15). */
  concurrency?: number;
  /** INSIDER_EXIT / SELL_IMPAIRED / LIQ_IMPAIRED resolve for qualified-lane
   *  launches only; DRAWDOWN_80 / TRADING_ALIVE stay universal. Env:
   *  OUTCOMES_QUALIFIED_ONLY. Off by default (current behavior unchanged). */
  qualifiedOnly?: boolean;
}

export async function runOutcomesLoop(
  client: ResolveClient,
  signal: { stopped: boolean },
  opts: OutcomesLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const batch = opts.batch ?? Number(process.env.OUTCOMES_BATCH || 25);
  const concurrency = opts.concurrency ?? Number(process.env.OUTCOMES_CONCURRENCY || 4);
  // 2026-09-15: every index-lane launch (the ~87% that never clear the qualified
  // bar) still gets INSIDER_EXIT / SELL_IMPAIRED / LIQ_IMPAIRED rows created
  // (spec §1's "applies to: all" for INSIDER_EXIT), and INSIDER_EXIT resolution
  // costs ~80 sequential getLogs vs ~2 quoter calls for SELL_IMPAIRED — so a
  // shared RPC budget spends most of itself resolving outcomes for tokens
  // nobody qualified to buy. Off by default: identical behavior until opted in.
  // DRAWDOWN_80 / TRADING_ALIVE stay universal either way (backfill's own
  // qualifiedOnly semantics, reused here) — they apply to every launch by spec.
  const qualifiedOnly = opts.qualifiedOnly ?? /^(1|true|yes)$/i.test(process.env.OUTCOMES_QUALIFIED_ONLY || '');
  // eslint-disable-next-line no-console
  console.log(
    `[outcomes] resolution loop every ${intervalMs / 1000}s, batch ${batch}, concurrency ${concurrency}, ` +
      `fair across labels${qualifiedOnly ? ', qualified-lane only for INSIDER_EXIT/SELL_IMPAIRED/LIQ_IMPAIRED' : ''}`,
  );
  while (!signal.stopped) {
    try {
      const r = await sweepDueOutcomes(client, batch, { order: 'fair', concurrency, qualifiedOnly });
      if (r.picked > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[outcomes] swept ${r.picked}: ${r.resolved} resolved · ${r.na} n/a · ${r.unresolvable} unresolvable · ${r.retryLater} retry · ${r.failed} error`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[outcomes] sweep error', err instanceof Error ? err.message : err);
      await recordFailure('outcomes.sweep_error', err);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
