import { Prisma, prisma, type $Enums } from '@launch-auditor/db';
import { ALL_OUTCOME_KEYS, outcomeApplies } from '@launch-auditor/scoring';
import { horizonMs } from './resolve';

export interface EnsureOutcomeInput {
  chainId: number;
  tokenAddress: string;
  reportTime: Date;
  trigger: string;
  launchId: string | null;
  lpLockedByConstruction: boolean;
  retrospective?: boolean;
}

/**
 * Materialise one Outcome row per applicable (label, horizon) for a report's
 * anchor time (spec §1 grid). Idempotent via the unique key
 * (chainId, tokenAddress, anchorTime, label, horizon, ruleVersion). Launchpad
 * tokens get NA rows for SELL_IMPAIRED / LIQ_IMPAIRED so the grid stays complete.
 */
export async function ensureOutcomeRows(
  input: EnsureOutcomeInput,
): Promise<{ created: number }> {
  const anchorTime = input.reportTime;
  const rows: Prisma.OutcomeCreateManyInput[] = ALL_OUTCOME_KEYS.map((key) => {
    const [label, horizon] = key.split('@') as [string, string];
    const applies = outcomeApplies(key, {
      lpLockedByConstruction: input.lpLockedByConstruction,
    });
    return {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress.toLowerCase(),
      anchorTime,
      trigger: input.trigger as $Enums.ReportTrigger,
      launchId: input.launchId,
      label: label as $Enums.OutcomeLabel,
      horizon,
      ruleVersion: 'v1',
      status: (applies ? 'PENDING' : 'NA') as $Enums.OutcomeStatus,
      value: null,
      horizonAt: new Date(anchorTime.getTime() + horizonMs(horizon)),
      retrospective: input.retrospective ?? false,
    } satisfies Prisma.OutcomeCreateManyInput;
  });

  const res = await prisma.outcome.createMany({ data: rows, skipDuplicates: true });
  return { created: res.count };
}
