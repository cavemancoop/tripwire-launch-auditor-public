import type { FeatureInputs } from './inputs';
import type { OutcomeKey } from './types';
import { ALL_OUTCOME_KEYS, outcomeApplies, outcomeIsPositive } from './types';

// `heuristic_v1` (spec §2): a fixed rule, scored as its own forecaster.
//   creator dev-buy ≥ 5% of supply
//   OR launch-block cluster ≥ 3 wallets
//   OR top-10 non-creator share at T+10m ≥ 40%
// It fires a single manipulation flag applied uniformly to every outcome/horizon;
// the benchmark then shows which outcomes it actually predicts.

export const HEURISTIC_V1_THRESHOLDS = {
  devbuyPct: 5,
  launchBlockCluster: 3,
  top10NoncreatorPct: 40,
} as const;

/** score emitted when the flag fires / doesn't (rough, uncalibrated) */
export const HEURISTIC_V1_SCORE = { fired: 0.8, clear: 0.12 } as const;

export interface HeuristicV1Result {
  fired: boolean;
  reasons: string[];
  probabilities: Partial<Record<OutcomeKey, number>>;
}

export function heuristicV1(inputs: FeatureInputs): HeuristicV1Result {
  const reasons: string[] = [];
  if ((inputs.creatorDevbuyPct ?? 0) >= HEURISTIC_V1_THRESHOLDS.devbuyPct) {
    reasons.push(`creator_devbuy_pct ≥ ${HEURISTIC_V1_THRESHOLDS.devbuyPct}`);
  }
  if ((inputs.launchBlockClusterSize ?? 0) >= HEURISTIC_V1_THRESHOLDS.launchBlockCluster) {
    reasons.push(`launch_block_cluster ≥ ${HEURISTIC_V1_THRESHOLDS.launchBlockCluster}`);
  }
  if ((inputs.top10NoncreatorPct ?? 0) >= HEURISTIC_V1_THRESHOLDS.top10NoncreatorPct) {
    reasons.push(`top10_noncreator_pct ≥ ${HEURISTIC_V1_THRESHOLDS.top10NoncreatorPct}`);
  }

  const fired = reasons.length > 0;
  const p = fired ? HEURISTIC_V1_SCORE.fired : HEURISTIC_V1_SCORE.clear;
  const probabilities: Partial<Record<OutcomeKey, number>> = {};
  for (const k of ALL_OUTCOME_KEYS) {
    if (!outcomeApplies(k, inputs)) continue;
    // TRADING_ALIVE is inverted — a fired flag lowers P(still trading)
    probabilities[k] = outcomeIsPositive(k) ? 1 - p : p;
  }

  return { fired, reasons, probabilities };
}
