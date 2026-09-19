import v01Json from '../weights/det_v0_1.json';
import weightsJson from '../weights/det_v0.json';
import { type FeatureInputs, type FeatureName, sigmoid, standardize } from './inputs';
import type { OutcomeKey } from './types';
import { ALL_OUTCOME_KEYS, outcomeApplies } from './types';

// `det_v0` (spec §4): one hand-set logistic per outcome/horizon over the
// standardized feature vector. Weights are frozen in weights/det_v0.json and
// committed before live operation; det_v1 re-fits them from the backfill.

export interface OutcomeWeights {
  bias: number;
  weights: Partial<Record<FeatureName, number>>;
}

export interface DetWeights {
  version: string;
  note?: string;
  outcomes: Partial<Record<OutcomeKey, OutcomeWeights>>;
}

export const DET_V0_WEIGHTS: DetWeights = weightsJson as DetWeights;

export interface DetV0Result {
  version: string;
  probabilities: Partial<Record<OutcomeKey, number>>;
}

export function detV0(
  inputs: FeatureInputs,
  weights: DetWeights = DET_V0_WEIGHTS,
): DetV0Result {
  const z = standardize(inputs);
  const probabilities: Partial<Record<OutcomeKey, number>> = {};

  for (const key of ALL_OUTCOME_KEYS) {
    if (!outcomeApplies(key, inputs)) continue;
    const w = weights.outcomes[key];
    if (!w) continue;
    let logit = w.bias;
    for (const [name, coef] of Object.entries(w.weights)) {
      if (coef === undefined) continue;
      logit += coef * (z[name as FeatureName] ?? 0);
    }
    probabilities[key] = round4(sigmoid(logit));
  }

  return { version: weights.version, probabilities };
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

// ── det_v0.1 (checkpoint §8.3) ──────────────────────────────────────────
// det_v0 with per-outcome intercepts overridden by logit(observed base rate)
// from the 3-day backfill pass. Scored as its own forecaster; both run live so
// the tuning is visible. While `biasOverride` is empty it equals det_v0.

export interface DetV01Overrides {
  version: string;
  basedOn: string;
  note?: string;
  biasOverride: Partial<Record<OutcomeKey, number>>;
}

export const DET_V0_1_OVERRIDES: DetV01Overrides = v01Json as DetV01Overrides;

/** logit — helper for setting `biasOverride` from an observed base rate. */
export function logit(p: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(c / (1 - c));
}

export function mergeDetV01(
  base: DetWeights = DET_V0_WEIGHTS,
  overrides: DetV01Overrides = DET_V0_1_OVERRIDES,
): DetWeights {
  const outcomes: Partial<Record<OutcomeKey, OutcomeWeights>> = {};
  for (const [key, w] of Object.entries(base.outcomes)) {
    if (!w) continue;
    const ov = overrides.biasOverride[key as OutcomeKey];
    outcomes[key as OutcomeKey] = ov === undefined ? w : { bias: ov, weights: w.weights };
  }
  return { version: overrides.version, note: overrides.note, outcomes };
}

export function detV0_1(inputs: FeatureInputs): DetV0Result {
  return detV0(inputs, mergeDetV01());
}

