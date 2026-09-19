/**
 * M5b-3 — the IDS (Internal Discrepancy Signal) reconciler.
 *
 * Spec §8 / 2026-09-09 decision: "local `MetabolismSpend` sum vs
 * `orbio_get_balance.spent.usd` mismatch → REVOKING → revoke_key → NO_KEY".
 *
 * Orbio exposes only an account-wide gateway `spent.usd`, never per-key usage, so
 * the reconcile is done **against a per-key baseline**: when a key is minted the
 * runner snapshots `(provider spent, local ledger Σ)`; thereafter it compares the
 * two *deltas since that snapshot*. Only the provider outpacing the local ledger
 * (beyond a settlement grace) is a compromise signal — the reverse just means a
 * deep-dive has not settled yet, or our cost recording is high, neither of which
 * revoking would fix.
 */

export interface SpendBaseline {
  /** the gateway key prefix this baseline belongs to */
  keyPrefix: string;
  /** orbio_get_balance.spent.usd at the moment the baseline was taken */
  providerSpentUsd: number;
  /** Σ MetabolismSpend.costUsd at the moment the baseline was taken */
  ledgerUsd: number;
  /** ISO */
  at: string;
}

export interface IdsReconcileInput {
  /** current gateway key prefix (orbio_get_key_status.prefix), or null when there is no key */
  keyPrefix: string | null;
  /** orbio_get_balance.spent.usd now */
  providerSpentUsd: number;
  /** Σ MetabolismSpend.costUsd now */
  ledgerSpendUsd: number;
  baseline: SpendBaseline | null;
  /** hard tolerance for rounding noise */
  toleranceUsd: number;
  /** absorbs ~one in-flight deep-dive that has spent but not been recorded yet */
  graceUsd: number;
}

export type IdsDirection = 'ok' | 'provider_ahead' | 'ledger_ahead' | 'no_baseline';

export interface IdsReconcile {
  /** true only when the provider has outpaced the local ledger beyond the grace band */
  mismatch: boolean;
  direction: IdsDirection;
  /** provider gateway spend since the baseline */
  providerDeltaUsd: number;
  /** local ledger spend since the baseline */
  ledgerDeltaUsd: number;
  /** providerDelta − ledgerDelta ( > 0 ⇒ provider ahead ) */
  excessUsd: number;
  reason: string;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const usd = (n: number): string => `$${n.toFixed(4)}`;

export function reconcileIds(i: IdsReconcileInput): IdsReconcile {
  const zero = { providerDeltaUsd: 0, ledgerDeltaUsd: 0, excessUsd: 0 };

  if (!i.keyPrefix || !i.baseline || i.baseline.keyPrefix !== i.keyPrefix) {
    return {
      mismatch: false,
      direction: 'no_baseline',
      ...zero,
      reason: 'no spend baseline for the current key — establishing',
    };
  }

  const providerDeltaUsd = round6(i.providerSpentUsd - i.baseline.providerSpentUsd);
  const ledgerDeltaUsd = round6(i.ledgerSpendUsd - i.baseline.ledgerUsd);
  const excessUsd = round6(providerDeltaUsd - ledgerDeltaUsd);
  const band = Math.max(i.toleranceUsd, i.graceUsd);

  if (excessUsd > band) {
    return {
      mismatch: true,
      direction: 'provider_ahead',
      providerDeltaUsd,
      ledgerDeltaUsd,
      excessUsd,
      reason: `ids: gateway spent ${usd(providerDeltaUsd)} since key ${i.keyPrefix} was minted but the local ledger recorded only ${usd(ledgerDeltaUsd)} (excess ${usd(excessUsd)} > ${usd(band)})`,
    };
  }

  if (-excessUsd > band) {
    return {
      mismatch: false,
      direction: 'ledger_ahead',
      providerDeltaUsd,
      ledgerDeltaUsd,
      excessUsd,
      reason: `local ledger ${usd(ledgerDeltaUsd)} exceeds gateway spend ${usd(providerDeltaUsd)} by ${usd(-excessUsd)} — unsettled or over-recorded, not a compromise`,
    };
  }

  return {
    mismatch: false,
    direction: 'ok',
    providerDeltaUsd,
    ledgerDeltaUsd,
    excessUsd,
    reason: `ids ok — gateway ${usd(providerDeltaUsd)} vs ledger ${usd(ledgerDeltaUsd)} (excess ${usd(excessUsd)} ≤ ${usd(band)})`,
  };
}
