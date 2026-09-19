import type { Eligibility } from '@launch-auditor/scoring';

export {
  ELIGIBILITY_CLASSES,
  REPLAY_AFTER_MS,
  classifyEligibility,
  scannerFetchIsTimely,
  type Eligibility,
  type EligibilityInput,
} from '@launch-auditor/scoring';

export type ExclusionCounts = Record<string, Record<string, Partial<Record<Eligibility, number>>>>;

/** counts[outcomeKey][forecaster][class] += 1 */
export function countExclusion(counts: ExclusionCounts, outcomeKey: string, forecaster: string, e: Eligibility): void {
  const byF = (counts[outcomeKey] ??= {});
  const byE = (byF[forecaster] ??= {});
  byE[e] = (byE[e] ?? 0) + 1;
}
