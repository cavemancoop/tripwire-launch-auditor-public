/**
 * Deep-dive budget helpers. The budget formula and the run gate live in
 * @launch-auditor/db so the API display runs the same calculation.
 */
export {
  dailyDeepdiveBudget,
  deepdiveRunGate,
  type BudgetBreakdown,
  type BudgetInputs,
  type DeepdiveRunGate,
  type DeepdiveRunGateInputs,
} from '@launch-auditor/db';

export function reserveUsd(reserveR: number, claimSizeUsd: number): number {
  return Math.max(0, reserveR) * Math.max(0, claimSizeUsd);
}

/** How many deep-dive runs today's budget affords at the per-run cap. */
export function runsAffordable(budgetUsd: number, capPerRunUsd: number): number {
  if (capPerRunUsd <= 0) return 0;
  return Math.floor(budgetUsd / capPerRunUsd);
}
/** Days since the last manual credential action (spec §8 headline metric). */
export function daysUnattended(lastManualActionAt: Date | null, now: Date = new Date()): number {
  if (!lastManualActionAt) return 0;
  return Math.max(0, (now.getTime() - lastManualActionAt.getTime()) / 86_400_000);
}

