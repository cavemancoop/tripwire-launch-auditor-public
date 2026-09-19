/**
 * `GET /v1/launch/:token` — Codex Phase A #2 / Phase B #2: "the public API
 * cannot reproduce the benchmark." Outsiders could read forecasts
 * (`/v1/report`) and the scored table (`/v1/benchmark`) but never the inputs
 * behind either one — primary-pool selection, the raw feature vector, or the
 * outcome labels/evidence a resolved cell is built from. This is the read-only
 * detail view that closes that gap: everything `collectScoreRows` (the
 * worker's own scorer input) reads for one token, in one response.
 */
import { prisma } from '@launch-auditor/db';

export interface LaunchDetailRow {
  token: string;
  chainId: number;
  source: string;
  sourceConfidence: number | null;
  creatorAddress: string;
  launchBlock: string; // bigint, stringified — exceeds Number precision
  launchTxHash: string;
  launchAt: string | null;
  detectedVia: string | null;
  lane: string;
  quotaExceeded: boolean;
  retrospective: boolean;
  primaryPool: {
    lpLockedByConstruction: boolean;
    quoteAddress: string | null;
    poolKind: string | null;
    poolAddress: string | null;
    poolId: string | null;
    poolFee: number | null;
    poolTickSpacing: number | null;
    poolHooks: string | null;
    /** fee >= 10% — flagged as a likely decoy / token-vs-token pool, not excluded */
    poolFeeSuspect: boolean;
    /** last time primary-pool selection was re-evaluated; null = never */
    primaryPoolCheckedAt: string | null;
    tokenAgeAtPoolSec: number | null;
  };
  feature: Record<string, unknown> | null;
  outcomes: Array<{
    label: string;
    horizon: string;
    status: string;
    value: boolean | null;
    trigger: string;
    anchorTime: string;
    ruleVersion: string;
    evidence: unknown;
    coverage: unknown;
    retrospective: boolean;
    measuredAt: string | null;
  }>;
}

export type LaunchDetailReader = (token: string) => Promise<LaunchDetailRow | null>;

/** Feature columns that aren't part of the public vector (internal ids / fks). */
const FEATURE_OMIT = new Set(['id', 'launchId']);

export const prismaLaunchDetailReader: LaunchDetailReader = async (token) => {
  const launch = await prisma.launch.findFirst({
    where: { tokenAddress: token },
    include: { feature: true, outcomes: { orderBy: [{ label: 'asc' }, { horizon: 'asc' }] } },
  });
  if (!launch) return null;

  let feature: Record<string, unknown> | null = null;
  if (launch.feature) {
    feature = {};
    for (const [k, v] of Object.entries(launch.feature)) {
      if (FEATURE_OMIT.has(k)) continue;
      feature[k] = v instanceof Date ? v.toISOString() : v;
    }
  }

  return {
    token: launch.tokenAddress,
    chainId: launch.chainId,
    source: launch.source,
    sourceConfidence: launch.sourceConfidence,
    creatorAddress: launch.creatorAddress,
    launchBlock: launch.launchBlock.toString(),
    launchTxHash: launch.launchTxHash,
    launchAt: launch.launchAt?.toISOString() ?? null,
    detectedVia: launch.detectedVia,
    lane: launch.lane,
    quotaExceeded: launch.quotaExceeded,
    retrospective: launch.retrospective,
    primaryPool: {
      lpLockedByConstruction: launch.lpLockedByConstruction,
      quoteAddress: launch.quoteAddress,
      poolKind: launch.poolKind,
      poolAddress: launch.poolAddress,
      poolId: launch.poolId,
      poolFee: launch.poolFee,
      poolTickSpacing: launch.poolTickSpacing,
      poolHooks: launch.poolHooks,
      poolFeeSuspect: launch.poolFeeSuspect,
      primaryPoolCheckedAt: launch.primaryPoolCheckedAt?.toISOString() ?? null,
      tokenAgeAtPoolSec: launch.tokenAgeAtPoolSec,
    },
    feature,
    outcomes: launch.outcomes.map((o) => ({
      label: o.label,
      horizon: o.horizon,
      status: o.status,
      value: o.value,
      trigger: o.trigger,
      anchorTime: o.anchorTime.toISOString(),
      ruleVersion: o.ruleVersion,
      evidence: o.evidence,
      coverage: o.coverage,
      retrospective: o.retrospective,
      measuredAt: o.measuredAt?.toISOString() ?? null,
    })),
  };
};
