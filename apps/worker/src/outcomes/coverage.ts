/**
 * Scan-coverage record attached to every resolved outcome (checkpoint §C step 2:
 * "every outcome row stores blocks scanned, chunk size, call count, and gaps").
 * Lets the scorer and the dashboard show how much of the window was actually
 * observed, and never treat a gap as a clean result.
 */
export interface Coverage {
  fromBlock: number;
  toBlock: number;
  blocksScanned: number;
  chunkSize: number;
  callCount: number;
  /** ranges / conditions where data was missing or capped */
  gaps: string[];
  notes: string[];
}

export function newCoverage(fromBlock: bigint, toBlock: bigint, chunkSize: number): Coverage {
  const span = toBlock >= fromBlock ? Number(toBlock - fromBlock) + 1 : 0;
  return {
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    blocksScanned: span,
    chunkSize,
    callCount: chunkSize > 0 ? Math.ceil(span / chunkSize) : 0,
    gaps: [],
    notes: [],
  };
}

export function mergeCoverage(a: Coverage, b: Coverage): Coverage {
  return {
    fromBlock: Math.min(a.fromBlock, b.fromBlock),
    toBlock: Math.max(a.toBlock, b.toBlock),
    blocksScanned: a.blocksScanned + b.blocksScanned,
    chunkSize: Math.max(a.chunkSize, b.chunkSize),
    callCount: a.callCount + b.callCount,
    gaps: [...a.gaps, ...b.gaps],
    notes: [...a.notes, ...b.notes],
  };
}
