import { Prisma, prisma, type $Enums } from '@launch-auditor/db';
import { ensureOutcomeRows } from '../outcomes/enumerate';
import { probabilitiesToColumns } from './crypto';
import type { ReportDraft } from './types';

/**
 * Upsert report drafts as `reports` rows (keyed by the unique reportHash).
 * Passing reports become eligible for the commit job; failing reports are
 * stored with their validator reasons and never committed (spec §8.3).
 */
export async function persistLaunchReports(
  drafts: ReportDraft[],
): Promise<{ stored: number; passed: number; failed: number }> {
  let passed = 0;
  for (const d of drafts) {
    const cols = probabilitiesToColumns(d.content.probabilities);
    const common = {
      eip712Signature: d.signature,
      signerAddress: d.signer,
      validatorPassed: d.validatorPassed,
      validatorFailures: d.validatorFailures as Prisma.InputJsonValue,
    };
    await prisma.report.upsert({
      where: { reportHash: d.reportHash },
      create: {
        chainId: d.content.chainId,
        tokenAddress: d.content.tokenAddress,
        reportTime: new Date(d.content.reportTime),
        trigger: d.content.trigger as $Enums.ReportTrigger,
        forecaster: d.content.forecaster as $Enums.ForecasterKind,
        forecasterVersion: d.content.forecasterVersion,
        launchId: d.content.launchId,
        pInsiderExit6h: cols.pInsiderExit6h,
        pInsiderExit24h: cols.pInsiderExit24h,
        pInsiderExit72h: cols.pInsiderExit72h,
        pSellImpaired1h: cols.pSellImpaired1h,
        pSellImpaired24h: cols.pSellImpaired24h,
        pLiqImpaired24h: cols.pLiqImpaired24h,
        pLiqImpaired7d: cols.pLiqImpaired7d,
        pDrawdown80_24h: cols.pDrawdown80_24h,
        pDrawdown80_7d: cols.pDrawdown80_7d,
        pTradingAlive24h: cols.pTradingAlive24h,
        pTradingAlive7d: cols.pTradingAlive7d,
        coverage: d.content.coverage as Prisma.InputJsonValue,
        blockPin: d.content.blockPin as unknown as Prisma.InputJsonValue,
        confidence: d.content.confidence ?? null,
        evidence:
          d.content.evidence === undefined
            ? undefined
            : (d.content.evidence as unknown as Prisma.InputJsonValue),
        canonicalJson: d.canonicalJson,
        reportHash: d.reportHash,
        ...common,
      },
      update: common,
    });
    if (d.validatorPassed) passed += 1;
  }

  // M4: materialise the Outcome grid for this report's anchor time. One batch
  // shares (chainId, tokenAddress, reportTime, trigger, launchId).
  const first = drafts[0]?.content;
  if (first?.launchId) {
    const launch = await prisma.launch.findUnique({
      where: { id: first.launchId },
      select: { lpLockedByConstruction: true, retrospective: true },
    });
    if (launch) {
      await ensureOutcomeRows({
        chainId: first.chainId,
        tokenAddress: first.tokenAddress,
        reportTime: new Date(first.reportTime),
        trigger: first.trigger,
        launchId: first.launchId,
        lpLockedByConstruction: launch.lpLockedByConstruction,
        retrospective: launch.retrospective,
      });
    }
  }

  return { stored: drafts.length, passed, failed: drafts.length - passed };
}
