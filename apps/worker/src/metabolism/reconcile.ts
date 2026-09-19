/**
 * M5c — epoch reconciliation. Replaces the per-key IDS revoke.
 *
 * The 2026-09-12 near-failure: the ledger was empty (the gateway exposes no
 * per-request cost), the provider's spend grew, and the reconciler read the
 * difference as a compromised key. One number had been made to do three jobs:
 *
 *   1. what Orbio actually charged        → `orbio_get_balance.spent.usd`, authoritative
 *   2. which report caused it             → a token-priced estimate with an explicit basis
 *   3. whether the agent is safe to run   → three independent controls (below)
 *
 * Each lifecycle tick is an epoch: the provider's spend delta over the window is
 * compared with the sum of local estimates recorded in it. The ratio is the
 * reconciliation factor (applied back to those rows as
 * `provider_reconciled_estimate`); the discrepancy is the estimator's error —
 * the agent forecasting its own cost and being graded on it, same as every other
 * forecaster in the project.
 *
 * Controls, in order of severity:
 *   - PHANTOM  provider spend rose while the agent made no calls → the only
 *              signal that means "someone else is using the key" → revoke.
 *   - ANOMALY  estimator off by more than `anomalyPct` → pause inference and
 *              alert; never revoke — a bad estimate is not a bad key.
 *   - hard budget and velocity live in `budget.ts` and read the provider figure.
 *
 * Pure. The runner tracks consecutive anomalies across ticks.
 */

export type CostBasis =
  | 'token_estimate'
  | 'provider_reconciled_estimate'
  | 'provider_reported'
  | 'provider_generation'
  | 'unavailable';

export type BillingStatus = 'exact' | 'aggregate_only' | 'unavailable' | 'anomaly' | 'phantom';

export interface EpochInput {
  /** orbio_get_balance.spent.usd now */
  providerSpendNowUsd: number;
  /** the previous epoch's providerSpendUsd, or the key baseline on the first tick */
  providerSpendPrevUsd: number;
  /** Σ MetabolismSpend.estimatedCostUsd for runs recorded since the previous epoch */
  localEstimateUsd: number;
  /** runs recorded since the previous epoch */
  requestCount: number;
  /** |discrepancy| above this (percent) is an anomaly for the window */
  anomalyPct: number;
  /** provider delta below this is rounding noise, not phantom spend */
  phantomToleranceUsd: number;
  /** runs recorded in the window BEFORE this one. Orbio charges land after the
   *  answer they pay for (agents doc §5), so a charge can arrive one window late:
   *  spend in an idle window that follows a busy one is lag, not phantom. */
  lagRequestCount?: number;
  /** below this on both sides, a window is too small to grade (sub-cent lag and
   *  rounding swing the percentage wildly). Default 0.02. */
  minGradeUsd?: number;
}

export interface EpochResult {
  providerDeltaUsd: number;
  localEstimateUsd: number;
  requestCount: number;
  /** providerDelta / localEstimate — null unless both are > 0 */
  reconciliationFactor: number | null;
  /** (provider − local) / local × 100 — null unless local > 0 */
  discrepancyPct: number | null;
  phantom: boolean;
  anomaly: boolean;
  billingStatus: BillingStatus;
  reason: string;
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const usd = (n: number): string => `$${n.toFixed(4)}`;

export function reconcileEpoch(i: EpochInput): EpochResult {
  const providerDeltaUsd = r6(Math.max(0, i.providerSpendNowUsd - i.providerSpendPrevUsd));
  const localEstimateUsd = r6(Math.max(0, i.localEstimateUsd));
  const base = { providerDeltaUsd, localEstimateUsd, requestCount: i.requestCount };

  // 1. the compromise signal: money left the account and we did nothing — in this
  //    window or the one before it (late-landing charges)
  if (i.requestCount === 0 && (i.lagRequestCount ?? 0) === 0 && providerDeltaUsd > i.phantomToleranceUsd) {
    return {
      ...base,
      reconciliationFactor: null,
      discrepancyPct: null,
      phantom: true,
      anomaly: false,
      billingStatus: 'phantom',
      reason: `phantom spend: provider charged ${usd(providerDeltaUsd)} this window with 0 local requests`,
    };
  }

  // 2. idle window — nothing to reconcile, nothing wrong (including a late charge
  //    for the previous window's requests)
  if (i.requestCount === 0) {
    return {
      ...base,
      reconciliationFactor: null,
      discrepancyPct: null,
      phantom: false,
      anomaly: false,
      billingStatus: 'aggregate_only',
      reason: 'idle window — no requests, no provider spend',
    };
  }

  // 3. requests ran but we could not price them (unpriced model / no token counts)
  if (localEstimateUsd <= 0) {
    return {
      ...base,
      reconciliationFactor: null,
      discrepancyPct: null,
      phantom: false,
      anomaly: false,
      billingStatus: 'unavailable',
      reason: `${i.requestCount} request(s) with no local estimate — provider charged ${usd(providerDeltaUsd)}; attribution unavailable`,
    };
  }

  // 4. too small to grade: sub-cent windows are dominated by billing lag
  const minGradeUsd = i.minGradeUsd ?? 0.02;
  if (localEstimateUsd < minGradeUsd && providerDeltaUsd < minGradeUsd) {
    return {
      ...base,
      reconciliationFactor: null,
      discrepancyPct: null,
      phantom: false,
      anomaly: false,
      billingStatus: 'aggregate_only',
      reason: `too small to grade: provider ${usd(providerDeltaUsd)} vs estimate ${usd(localEstimateUsd)} over ${i.requestCount} request(s) (both < ${usd(minGradeUsd)})`,
    };
  }

  // 5. the normal case — grade the estimator
  const factor = providerDeltaUsd > 0 ? r6(providerDeltaUsd / localEstimateUsd) : null;
  const discrepancyPct = r6(((providerDeltaUsd - localEstimateUsd) / localEstimateUsd) * 100);
  const anomaly = Math.abs(discrepancyPct) > i.anomalyPct;

  return {
    ...base,
    reconciliationFactor: factor,
    discrepancyPct,
    phantom: false,
    anomaly,
    billingStatus: anomaly ? 'anomaly' : 'aggregate_only',
    reason: anomaly
      ? `estimator anomaly: provider ${usd(providerDeltaUsd)} vs local estimate ${usd(localEstimateUsd)} over ${i.requestCount} request(s) — ${discrepancyPct > 0 ? '+' : ''}${discrepancyPct.toFixed(1)}% (limit ±${i.anomalyPct}%)`
      : `reconciled: provider ${usd(providerDeltaUsd)} vs estimate ${usd(localEstimateUsd)} over ${i.requestCount} request(s) — ${discrepancyPct > 0 ? '+' : ''}${discrepancyPct.toFixed(1)}%${factor != null ? `, factor ${factor.toFixed(4)}` : ''}`,
  };
}

/**
 * Whether inference should be gated closed on billing grounds. `phantom` and
 * `anomaly` both stop new runs; only `phantom` should revoke the key.
 */
export function billingBlocksInference(status: BillingStatus | null | undefined): boolean {
  return status === 'anomaly' || status === 'phantom';
}
