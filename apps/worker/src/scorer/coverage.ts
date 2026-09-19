/**
 * M12c — how much of each benchmark cell is actually graded. The resolver
 * can't keep up (~200k outcomes pending on 2026-09-18) and resolves some
 * labels for qualified launches only, so the graded rows are not a random
 * sample of the forecasts. The benchmark publishes the counts and the policy
 * next to the metrics rather than leave a reader to infer them.
 */
import { prisma } from '@launch-auditor/db';
import type { OutcomeKey } from '@launch-auditor/scoring';

export interface CellCoverage {
  resolved: number;
  /** horizon has passed, not yet graded */
  pendingDue: number;
  /** horizon still in the future */
  pendingNotDue: number;
  unresolvable: number;
  na: number;
  /** resolved backfill rows — counted from the rows' own flag, never inferred as all.n − live.n */
  retrospectiveResolved: number;
}

export type CoverageByCell = Partial<Record<OutcomeKey, CellCoverage>>;
export type CoverageReader = (now: Date) => Promise<CoverageByCell>;

const empty = (): CellCoverage => ({ resolved: 0, pendingDue: 0, pendingNotDue: 0, unresolvable: 0, na: 0, retrospectiveResolved: 0 });

/** Live (non-retrospective) outcome rows per (label, horizon), by status, plus resolved backfill rows. */
export const prismaCoverageReader: CoverageReader = async (now) => {
  const [byStatus, due, retro] = await Promise.all([
    prisma.outcome.groupBy({
      by: ['label', 'horizon', 'status'],
      where: { retrospective: false },
      _count: { _all: true },
    }),
    prisma.outcome.groupBy({
      by: ['label', 'horizon'],
      where: { retrospective: false, status: 'PENDING', horizonAt: { lte: now } },
      _count: { _all: true },
    }),
    prisma.outcome.groupBy({
      by: ['label', 'horizon'],
      where: { retrospective: true, status: 'RESOLVED' },
      _count: { _all: true },
    }),
  ]);
  const out: CoverageByCell = {};
  const cellOf = (label: string, horizon: string): CellCoverage =>
    (out[`${label}@${horizon}` as OutcomeKey] ??= empty());
  for (const g of byStatus) {
    const c = cellOf(g.label, g.horizon);
    const n = g._count._all;
    if (g.status === 'RESOLVED') c.resolved += n;
    else if (g.status === 'UNRESOLVABLE') c.unresolvable += n;
    else if (g.status === 'NA') c.na += n;
    else if (g.status === 'PENDING') c.pendingNotDue += n;
  }
  for (const g of due) {
    const c = cellOf(g.label, g.horizon);
    c.pendingDue += g._count._all;
    c.pendingNotDue -= g._count._all;
  }
  for (const g of retro) cellOf(g.label, g.horizon).retrospectiveResolved += g._count._all;
  return out;
};

/** One line on how graded rows are chosen, derived from the same flag the resolver reads. */
export function resolutionPolicy(qualifiedOnly: boolean): string {
  const scope = qualifiedOnly
    ? 'INSIDER_EXIT, SELL_IMPAIRED and LIQ_IMPAIRED are graded only for qualified launches (≥25 unique buyers in 10 min); DRAWDOWN_80 and TRADING_ALIVE for every launch.'
    : 'Every outcome is graded for every launch it applies to.';
  return (
    'Outcomes are graded after their horizon passes, in order of due time, sharing one RPC budget fairly across labels. ' +
    `${scope} ` +
    'The resolver does not keep up with every forecast, so graded rows are not a random sample: they lean toward qualified launches and toward whichever launches were reached first.'
  );
}

export const qualifiedOnlyFromEnv = (): boolean => /^(1|true|yes)$/i.test(process.env.OUTCOMES_QUALIFIED_ONLY || '');
