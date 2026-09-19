/**
 * Primitive scoring helpers. The full scorer (spec §2: AUROC, AUPRC, ECE,
 * DeLong comparison, minimum-sample rule) is built in M4.
 */

/** Trailing prevalence — the `base_rate` forecaster (spec §2). */
export function baseRate(labels: boolean[]): number {
  if (labels.length === 0) return 0;
  let positives = 0;
  for (const label of labels) if (label) positives += 1;
  return positives / labels.length;
}

/** Mean squared error between probabilities and {0,1} outcomes. */
export function brier(probabilities: number[], outcomes: boolean[]): number {
  if (probabilities.length !== outcomes.length) {
    throw new Error('brier: length mismatch');
  }
  if (probabilities.length === 0) {
    throw new Error('brier: empty input');
  }
  let sum = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    const p = probabilities[i]!;
    const y = outcomes[i]! ? 1 : 0;
    sum += (p - y) ** 2;
  }
  return sum / probabilities.length;
}

/** Brier Skill Score vs a reference (e.g. the trailing-30-day base rate). */
export function brierSkillScore(model: number, reference: number): number {
  if (reference === 0) return model === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return 1 - model / reference;
}
