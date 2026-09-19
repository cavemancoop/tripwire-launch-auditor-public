/**
 * Fast DeLong test for the difference between two correlated AUROCs on the same
 * labelled sample (Sun & Xu, 2014). Used for spec §2's "beats a baseline only
 * with a statistically significant AUROC gap on >= 200 resolved launches".
 */

function midranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length - 1 && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function covMatrix(rows: number[][]): number[][] {
  const k = rows.length;
  const L = rows[0]?.length ?? 0;
  const means = rows.map((r) => r.reduce((s, x) => s + x, 0) / (L || 1));
  const C: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const denom = L > 1 ? L - 1 : 1;
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let i = 0; i < L; i++) s += (rows[a]![i]! - means[a]!) * (rows[b]![i]! - means[b]!);
      C[a]![b] = s / denom;
      C[b]![a] = C[a]![b]!;
    }
  }
  return C;
}

/** Φ(x) via a rational erfc approximation (Abramowitz & Stegun 7.1.26). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = x >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

export interface DeLongResult {
  aucA: number;
  aucB: number;
  /** aucA - aucB */
  diff: number;
  se: number;
  z: number;
  /** two-sided p-value for H0: aucA == aucB */
  p: number;
  n: number;
}

export function fastDeLong(
  scoresA: number[],
  scoresB: number[],
  labels: boolean[],
): DeLongResult | null {
  if (scoresA.length !== labels.length || scoresB.length !== labels.length) return null;
  const posIdx: number[] = [];
  const negIdx: number[] = [];
  labels.forEach((y, i) => (y ? posIdx : negIdx).push(i));
  const m = posIdx.length;
  const n = negIdx.length;
  if (m < 2 || n < 2) return null;

  const preds = [scoresA, scoresB];
  const aucs: number[] = [];
  const v01: number[][] = []; // per predictor, length m
  const v10: number[][] = []; // per predictor, length n

  for (const pred of preds) {
    const tx = posIdx.map((i) => pred[i]!);
    const ty = negIdx.map((i) => pred[i]!);
    const tz = [...tx, ...ty];
    const tzr = midranks(tz);
    const txr = midranks(tx);
    const tyr = midranks(ty);
    const tzrPos = tzr.slice(0, m);
    const tzrNeg = tzr.slice(m);

    const auc = tzrPos.reduce((s, r) => s + r, 0) / (m * n) - (m + 1) / (2 * n);
    aucs.push(auc);
    v01.push(tzrPos.map((r, i) => (r - txr[i]!) / n));
    v10.push(tzrNeg.map((r, j) => 1 - (r - tyr[j]!) / m));
  }

  const sx = covMatrix(v01);
  const sy = covMatrix(v10);
  const s = (a: number, b: number): number => sx[a]![b]! / m + sy[a]![b]! / n;

  const varDiff = s(0, 0) + s(1, 1) - 2 * s(0, 1);
  const se = Math.sqrt(Math.max(varDiff, 0));
  const diff = aucs[0]! - aucs[1]!;
  const z = se > 0 ? diff / se : 0;
  const p = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;

  return { aucA: aucs[0]!, aucB: aucs[1]!, diff, se, z, p, n: m + n };
}
