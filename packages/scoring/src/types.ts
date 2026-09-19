/** Outcome horizons used across spec §1. */
export type Horizon = '1h' | '6h' | '24h' | '72h' | '7d';

export type OutcomeLabel =
  | 'INSIDER_EXIT'
  | 'SELL_IMPAIRED'
  | 'LIQ_IMPAIRED'
  | 'DRAWDOWN_80'
  | 'TRADING_ALIVE'; // M4e — the one positive outcome (value=true means still trading)

/** Canonical key for a scored cell, e.g. "INSIDER_EXIT@24h". */
export type OutcomeKey = `${OutcomeLabel}@${Horizon}`;

export function outcomeKey(label: OutcomeLabel, horizon: Horizon): OutcomeKey {
  return `${label}@${horizon}`;
}

/** Every (label, horizon) cell defined in spec §1, in a fixed order. */
export const ALL_OUTCOME_KEYS: readonly OutcomeKey[] = [
  'INSIDER_EXIT@6h',
  'INSIDER_EXIT@24h',
  'INSIDER_EXIT@72h',
  'SELL_IMPAIRED@1h',
  'SELL_IMPAIRED@24h',
  'LIQ_IMPAIRED@24h',
  'LIQ_IMPAIRED@7d',
  'DRAWDOWN_80@24h',
  'DRAWDOWN_80@7d',
  'TRADING_ALIVE@24h',
  'TRADING_ALIVE@7d',
] as const;

/**
 * SELL_IMPAIRED and LIQ_IMPAIRED are N/A for launchpad tokens (LP locked by
 * construction, spec §1). Everything else — including TRADING_ALIVE — applies to
 * all launches.
 */
export function outcomeApplies(
  key: OutcomeKey,
  opts: { lpLockedByConstruction: boolean },
): boolean {
  if (!opts.lpLockedByConstruction) return true;
  return !key.startsWith('SELL_IMPAIRED') && !key.startsWith('LIQ_IMPAIRED');
}

/** TRADING_ALIVE is inverted: value=true is the *good* outcome. Callers that
 *  reason about "higher probability = worse" should special-case it. */
export function outcomeIsPositive(key: OutcomeKey): boolean {
  return key.startsWith('TRADING_ALIVE');
}

export interface ForecastRow {
  launchId: string;
  forecaster: string;
  /** OutcomeKey -> probability in [0, 1]. Missing keys = not forecast. */
  probabilities: Partial<Record<OutcomeKey, number>>;
}

export interface ResolvedLabel {
  launchId: string;
  key: OutcomeKey;
  value: boolean;
}

/** Metrics reported per (outcome, horizon, forecaster) — spec §2. */
export interface Metrics {
  n: number;
  auroc: number | null;
  auprc: number | null;
  logLoss: number | null;
  brier: number | null;
  brierSkillScore: number | null;
  ece: number | null;
}
