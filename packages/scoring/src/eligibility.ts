/**
 * Which report-outcome pairs may count toward a benchmark claim — shared by
 * the worker's scorer and the API's per-report receipt so both label a report
 * the same way.
 *
 * The headline claim is "the forecast was committed before its outcome".
 * `reportTime` is the T+10m *block* time, not when the report was issued, so a
 * report built late — the 18 Sep outage replay, the 16 Sep 6.8h backlog —
 * carries an anchor from before it existed. The 2026-09-19 independent audit
 * found one committed 11h36m after its anchor, after two of its horizons had
 * ended.
 *
 * Time is the commit's *chain block time*, never a DB receipt-recording
 * timestamp. Signed reports are never edited or re-anchored: ineligible rows
 * are excluded from claims and counted, not rewritten.
 */

export type Eligibility = 'eligible' | 'replay' | 'late' | 'uncommitted' | 'missing_time';

export const ELIGIBILITY_CLASSES: Eligibility[] = ['eligible', 'replay', 'late', 'uncommitted', 'missing_time'];

/**
 * A normal commit lands 1–15 min after the T+10m anchor (5-min batches). Later
 * than this and the report was built late, with part of its outcome window
 * already observable, even if the horizon hadn't ended.
 */
export const REPLAY_AFTER_MS = 30 * 60_000;

const HORIZON_MS: Record<string, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '72h': 72 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

/** Horizon label ("1h" … "7d") → milliseconds. */
export function horizonToMs(horizon: string): number {
  const ms = HORIZON_MS[horizon];
  if (ms === undefined) throw new Error(`unknown horizon ${horizon}`);
  return ms;
}

export interface EligibilityInput {
  reportTime: Date;
  committed: boolean;
  /** block timestamp of the commit tx; null when committed but not readable */
  commitBlockTime: Date | null;
  horizonEnd: Date;
}

export function classifyEligibility(i: EligibilityInput): Eligibility {
  if (!i.committed) return 'uncommitted';
  if (!i.commitBlockTime) return 'missing_time';
  if (i.commitBlockTime.getTime() >= i.horizonEnd.getTime()) return 'late';
  if (i.commitBlockTime.getTime() - i.reportTime.getTime() > REPLAY_AFTER_MS) return 'replay';
  return 'eligible';
}

/**
 * Scanner baselines (ScanHood, GoPlus) are fetched when the T+10m job runs.
 * On a late job that's hours after launch — e.g. ScanHood's liquidity after a
 * rug — so a late fetch is hindsight, whatever the report's own eligibility.
 */
export function scannerFetchIsTimely(reportTime: Date, fetchedAt: Date | null): boolean {
  return fetchedAt !== null && fetchedAt.getTime() - reportTime.getTime() <= REPLAY_AFTER_MS;
}
