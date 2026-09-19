// Shared feature inputs for the deterministic forecasters (spec §3.3 / §4).
// Everything is nullable — the index/T+10m lanes fill what they can. Scorers
// impute a missing feature to its neutral value (0 contribution).

export interface FeatureInputs {
  /** launchpad key or "raw" (spec §3.3.1) */
  source: string;
  lpLockedByConstruction: boolean;

  creatorDevbuyPct: number | null; // %
  creatorAgeDays: number | null;
  creatorPriorLaunches: number | null;
  creatorPriorInsiderExitRate: number | null; // 0..1

  clusterSize: number | null;
  /** distinct wallets that bought in the launch block (ClusterRule LAUNCH_BLOCK_BUY) */
  launchBlockClusterSize: number | null;
  clusterSupplyPct: number | null; // %
  top10NoncreatorPct: number | null; // %

  uniqueBuyers10m: number | null;
  buysPerBuyer10m: number | null;
  microbuyShare10m: number | null; // 0..1

  liquidityUsd10m: number | null;
  sellImpactBps: number | null;

  hasX: boolean | null;
  hasSite: boolean | null;

  // non-launchpad only (spec §3.3.9)
  verified: boolean | null;
  ownerRenounced: boolean | null;
  mintable: boolean | null;
  sellSimOk: boolean | null;
  sellTaxBps: number | null;

  // M4e — v4 hook / side-pool / approval surface (the pre-staged-exit surface)
  hookCanBlockSwap: boolean | null;
  hookCanTaxSwap: boolean | null;
  hookGatesLpRemoval: boolean | null;
  sidePoolCount: number | null;
  creatorApprovalsOutsideRouters: number | null;
}

/** every standardized feature name the weights file may reference */
export type FeatureName =
  | 'creatorDevbuyPct'
  | 'creatorAgeDays'
  | 'creatorPriorLaunches'
  | 'creatorPriorInsiderExitRate'
  | 'clusterSize'
  | 'launchBlockClusterSize'
  | 'clusterSupplyPct'
  | 'top10NoncreatorPct'
  | 'uniqueBuyers10m'
  | 'buysPerBuyer10m'
  | 'microbuyShare10m'
  | 'liquidityUsd10m'
  | 'sellImpactBps'
  | 'hasX'
  | 'hasSite'
  | 'verified'
  | 'ownerRenounced'
  | 'mintable'
  | 'sellSimOk'
  | 'sellTaxBps'
  | 'lpLockedByConstruction'
  | 'hookCanBlockSwap'
  | 'hookCanTaxSwap'
  | 'hookGatesLpRemoval'
  | 'sidePoolCount'
  | 'creatorApprovalsOutsideRouters';

const log1p = (x: number): number => Math.log(1 + Math.max(0, x));

/** true -> +1, false -> -1, null -> 0 (unknown contributes nothing) */
const tri = (b: boolean | null): number => (b === null ? 0 : b ? 1 : -1);

/** (x - center) / scale, missing -> 0 */
const z = (x: number | null, center: number, scale: number): number =>
  x === null || !Number.isFinite(x) ? 0 : (x - center) / scale;

/**
 * Map raw feature inputs to a standardized numeric vector. Centers/scales are
 * rough hand-set priors (v0), documented alongside `weights/det_v0.json`; the
 * fitted `det_v1` (§4) will re-derive both from the backfill set.
 */
export function standardize(inputs: FeatureInputs): Record<FeatureName, number> {
  return {
    creatorDevbuyPct: z(inputs.creatorDevbuyPct, 3, 8), // center 3%, scale 8pp
    creatorAgeDays: z(inputs.creatorAgeDays === null ? null : log1p(inputs.creatorAgeDays), log1p(30), 1.5),
    creatorPriorLaunches: z(inputs.creatorPriorLaunches === null ? null : log1p(inputs.creatorPriorLaunches), log1p(1), 1),
    creatorPriorInsiderExitRate: z(inputs.creatorPriorInsiderExitRate, 0.3, 0.3),
    clusterSize: z(inputs.clusterSize === null ? null : log1p(inputs.clusterSize), log1p(1), 1),
    launchBlockClusterSize: z(inputs.launchBlockClusterSize, 1, 2),
    clusterSupplyPct: z(inputs.clusterSupplyPct, 5, 12),
    top10NoncreatorPct: z(inputs.top10NoncreatorPct, 25, 20),
    uniqueBuyers10m: z(inputs.uniqueBuyers10m === null ? null : log1p(inputs.uniqueBuyers10m), log1p(30), 1.5),
    buysPerBuyer10m: z(inputs.buysPerBuyer10m, 2, 3),
    microbuyShare10m: z(inputs.microbuyShare10m, 0.3, 0.3),
    liquidityUsd10m: z(inputs.liquidityUsd10m === null ? null : log1p(inputs.liquidityUsd10m), log1p(5000), 2),
    sellImpactBps: z(inputs.sellImpactBps === null ? null : log1p(inputs.sellImpactBps), log1p(100), 1.5),
    hasX: tri(inputs.hasX),
    hasSite: tri(inputs.hasSite),
    verified: tri(inputs.verified),
    ownerRenounced: tri(inputs.ownerRenounced),
    mintable: tri(inputs.mintable),
    sellSimOk: tri(inputs.sellSimOk),
    sellTaxBps: z(inputs.sellTaxBps, 0, 300),
    lpLockedByConstruction: inputs.lpLockedByConstruction ? 1 : -1,
    hookCanBlockSwap: tri(inputs.hookCanBlockSwap),
    hookCanTaxSwap: tri(inputs.hookCanTaxSwap),
    hookGatesLpRemoval: tri(inputs.hookGatesLpRemoval),
    sidePoolCount: z(inputs.sidePoolCount, 1, 3),
    creatorApprovalsOutsideRouters: z(inputs.creatorApprovalsOutsideRouters, 0, 2),
  };
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
