/**
 * Discrimination + calibration metrics for one (outcome, horizon, forecaster)
 * cell (spec §2). All take aligned `scores` (probabilities in [0,1]) and
 * `labels` (booleans). Empty / single-class inputs return null rather than a
 * misleading number.
 */

/** midrank (average rank for ties), 1-based, for an already-index-aligned array */
function midranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length - 1 && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function split(scores: number[], labels: boolean[]): { pos: number[]; neg: number[] } {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < scores.length; i++) (labels[i] ? pos : neg).push(scores[i]!);
  return { pos, neg };
}

/** Area under the ROC curve via the rank-sum identity, with tie correction. */
export function auroc(scores: number[], labels: boolean[]): number | null {
  if (scores.length !== labels.length || scores.length === 0) return null;
  const { pos, neg } = split(scores, labels);
  if (pos.length === 0 || neg.length === 0) return null;
  const ranks = midranks(scores);
  let rankSumPos = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i]) rankSumPos += ranks[i]!;
  return (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/** Average precision (area under the precision-recall curve). */
export function auprc(scores: number[], labels: boolean[]): number | null {
  if (scores.length !== labels.length || scores.length === 0) return null;
  const totalPos = labels.reduce((n, y) => n + (y ? 1 : 0), 0);
  if (totalPos === 0) return null;
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let ap = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k]![1];
    if (labels[i]) tp++;
    else fp++;
    // only accumulate at the end of a group of equal scores
    if (k < order.length - 1 && order[k + 1]![0] === order[k]![0]) continue;
    const recall = tp / totalPos;
    const precision = tp / (tp + fp);
    ap += (recall - prevRecall) * precision;
    prevRecall = recall;
  }
  return ap;
}

const EPS = 1e-12;

export function logLoss(scores: number[], labels: boolean[]): number | null {
  if (scores.length !== labels.length || scores.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < scores.length; i++) {
    const p = Math.min(1 - EPS, Math.max(EPS, scores[i]!));
    sum += labels[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / scores.length;
}

export function brierScore(scores: number[], labels: boolean[]): number | null {
  if (scores.length !== labels.length || scores.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < scores.length; i++) {
    const y = labels[i] ? 1 : 0;
    sum += (scores[i]! - y) ** 2;
  }
  return sum / scores.length;
}

/** Expected calibration error over equal-width probability bins (deciles). */
export function ece(scores: number[], labels: boolean[], bins = 10): number | null {
  if (scores.length !== labels.length || scores.length === 0) return null;
  const binTotal = new Array<number>(bins).fill(0);
  const binPos = new Array<number>(bins).fill(0);
  const binConf = new Array<number>(bins).fill(0);
  for (let i = 0; i < scores.length; i++) {
    const p = Math.min(0.999999, Math.max(0, scores[i]!));
    const b = Math.min(bins - 1, Math.floor(p * bins));
    binTotal[b]!++;
    binConf[b]! += p;
    if (labels[i]) binPos[b]!++;
  }
  let eceSum = 0;
  for (let b = 0; b < bins; b++) {
    if (binTotal[b] === 0) continue;
    const acc = binPos[b]! / binTotal[b]!;
    const conf = binConf[b]! / binTotal[b]!;
    eceSum += (binTotal[b]! / scores.length) * Math.abs(acc - conf);
  }
  return eceSum;
}

export interface PrRecall {
  threshold: number;
  precision: number | null;
  recall: number | null;
  tp: number;
  fp: number;
  fn: number;
}

export function precisionRecallAt(
  scores: number[],
  labels: boolean[],
  threshold: number,
): PrRecall {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < scores.length; i++) {
    const pred = scores[i]! >= threshold;
    if (pred && labels[i]) tp++;
    else if (pred && !labels[i]) fp++;
    else if (!pred && labels[i]) fn++;
  }
  return {
    threshold,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    tp,
    fp,
    fn,
  };
}

/** Brier Skill Score of `model` Brier vs a `reference` Brier (spec §2). */
export function brierSkill(modelBrier: number, referenceBrier: number): number | null {
  if (referenceBrier <= 0) return null;
  return 1 - modelBrier / referenceBrier;
}
