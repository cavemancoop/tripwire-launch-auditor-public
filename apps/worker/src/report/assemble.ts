import { getChainConfig } from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import { detV0, detV0_1, heuristicV1, type FeatureInputs, type OutcomeKey } from '@launch-auditor/scoring';
import type { Hex, PublicClient } from 'viem';
import { loadEnv } from '../env';
import {
  agentAddress,
  canonicalJson,
  reportHash,
  signReportCommitment,
} from './crypto';
import type { BlockPin, ReportContent, ReportDraft } from './types';
import { validateReport } from './validate';

type LaunchWithFeature = NonNullable<
  Awaited<ReturnType<typeof loadLaunch>>
>;

function loadLaunch(launchId: string) {
  return prisma.launch.findUnique({ where: { id: launchId }, include: { feature: true } });
}

/** the FeatureInputs fields that count toward "coverage" (nullable signal features) */
const COVERAGE_KEYS: (keyof FeatureInputs)[] = [
  'creatorDevbuyPct',
  'creatorAgeDays',
  'creatorPriorLaunches',
  'creatorPriorInsiderExitRate',
  'clusterSize',
  'launchBlockClusterSize',
  'clusterSupplyPct',
  'top10NoncreatorPct',
  'uniqueBuyers10m',
  'buysPerBuyer10m',
  'microbuyShare10m',
  'liquidityUsd10m',
  'sellImpactBps',
  'hasX',
  'hasSite',
  'verified',
  'ownerRenounced',
  'mintable',
  'sellSimOk',
  'sellTaxBps',
];

export function toFeatureInputs(
  launch: LaunchWithFeature,
  launchBlockClusterSize: number,
): { inputs: FeatureInputs; coverage: string[] } {
  const f = launch.feature;
  const inputs: FeatureInputs = {
    source: launch.source,
    lpLockedByConstruction: launch.lpLockedByConstruction,
    creatorDevbuyPct: f?.creatorDevbuyPct ?? null,
    creatorAgeDays: f?.creatorAgeDays ?? null,
    creatorPriorLaunches: f?.creatorPriorLaunches ?? null,
    creatorPriorInsiderExitRate: f?.creatorPriorInsiderExitRate ?? null,
    clusterSize: f?.clusterSize ?? null,
    launchBlockClusterSize,
    clusterSupplyPct: f?.clusterSupplyPct ?? null,
    top10NoncreatorPct: f?.top10NoncreatorPct ?? null,
    uniqueBuyers10m: f?.uniqueBuyers10m ?? null,
    buysPerBuyer10m: f?.buysPerBuyer10m ?? null,
    microbuyShare10m: f?.microbuyShare10m ?? null,
    liquidityUsd10m: f?.liquidityUsd10m ?? null,
    sellImpactBps: f?.sellImpactBps ?? null,
    hasX: f?.hasX ?? null,
    hasSite: f?.hasSite ?? null,
    verified: f?.verified ?? null,
    ownerRenounced: f?.ownerRenounced ?? null,
    mintable: f?.mintable ?? null,
    sellSimOk: f?.sellSimOk ?? null,
    sellTaxBps: f?.sellTaxBps ?? null,
    hookCanBlockSwap: f?.hookCanBlockSwap ?? null,
    hookCanTaxSwap: f?.hookCanTaxSwap ?? null,
    hookGatesLpRemoval: f?.hookGatesLpRemoval ?? null,
    sidePoolCount: f?.sidePoolCount ?? null,
    creatorApprovalsOutsideRouters: f?.creatorApprovalsOutsideRouters ?? null,
  };
  const coverage = COVERAGE_KEYS.filter((k) => inputs[k] === null).map(String);
  return { inputs, coverage };
}

/**
 * Build signed + validated det_v0, det_v0.1 and heuristic_v1 report drafts for
 * a launch, pinned to the T+10m block. Not yet persisted. det_v0.1 is scored
 * alongside det_v0 but is not (yet) the forecaster posted to the public feed —
 * see DECISIONS.md.
 */
export async function buildLaunchReports(
  client: Pick<PublicClient, 'getBlock'>,
  launchId: string,
  trigger: string,
): Promise<ReportDraft[]> {
  const env = loadEnv();
  const launch = await loadLaunch(launchId);
  if (!launch) return [];

  const cfg = getChainConfig(launch.chainId);
  const launchBlockClusterSize = await prisma.clusterMember.count({
    where: { launchId, rule: 'LAUNCH_BLOCK_BUY' },
  });
  const { inputs, coverage } = toFeatureInputs(launch, launchBlockClusterSize);

  const blocksIn10m = BigInt(Math.round((10 * 60) / cfg.approxBlockSeconds));
  const block = await client.getBlock({ blockNumber: launch.launchBlock + blocksIn10m });
  const blockPin: BlockPin = {
    number: Number(block.number),
    hash: block.hash,
    timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
  };
  const reportTime = blockPin.timestamp;
  const reportTimeSec = Math.floor(Date.parse(reportTime) / 1000);

  const key = env.agentPrivateKey;
  const agentAddr = key ? agentAddress(key) : '0x0000000000000000000000000000000000000000';

  const forecasters: { name: string; version: string; probs: Partial<Record<OutcomeKey, number>> }[] = [
    { name: 'heuristic_v1', version: 'v1', probs: heuristicV1(inputs).probabilities },
    { name: 'det_v0', version: detV0(inputs).version, probs: detV0(inputs).probabilities },
    { name: 'det_v0_1', version: detV0_1(inputs).version, probs: detV0_1(inputs).probabilities },
  ];

  const drafts: ReportDraft[] = [];
  for (const fc of forecasters) {
    const content: ReportContent = {
      version: 'report/v0',
      chainId: launch.chainId,
      tokenAddress: launch.tokenAddress,
      launchId: launch.id,
      reportTime,
      trigger,
      blockPin,
      forecaster: fc.name,
      forecasterVersion: fc.version,
      outcomeRuleVersion: 'v1',
      probabilities: fc.probs,
      coverage,
    };
    const cj = canonicalJson(content);
    const rh = reportHash(cj);

    let signature: Hex | null = null;
    let signer: Hex | null = null;
    if (key) {
      const s = await signReportCommitment(key, {
        reportHash: rh,
        chainId: launch.chainId,
        token: launch.tokenAddress as Hex,
        reportTime: reportTimeSec,
        forecaster: fc.name,
      });
      signature = s.signature;
      signer = s.signer;
    }

    const draft: ReportDraft = {
      content,
      canonicalJson: cj,
      reportHash: rh,
      signature,
      signer,
      validatorPassed: false,
      validatorFailures: [],
    };
    const v = validateReport(draft, {
      expectedChainId: launch.chainId,
      expectedToken: launch.tokenAddress,
      agentAddress: agentAddr,
    });
    draft.validatorPassed = v.ok;
    draft.validatorFailures = v.failures;
    drafts.push(draft);
  }

  return drafts;
}
