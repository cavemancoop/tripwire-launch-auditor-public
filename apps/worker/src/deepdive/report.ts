/**
 * Assemble the `llm_deepdive_v0` forecast as a signed, §8.3-validated report
 * draft — the same `ReportDraft` shape the deterministic forecasters produce, so
 * `persistLaunchReports` stores it and the scorer picks it up with no special
 * casing (it is report-backed like `det_v0`).
 */
import type { OutcomeKey } from '@launch-auditor/scoring';
import type { Hex } from 'viem';
import {
  agentAddress,
  canonicalJson,
  reportHash,
  signReportCommitment,
} from '../report/crypto';
import type { BlockPin, ReportContent, ReportDraft } from '../report/types';
import { validateReport } from '../report/validate';
import type { TargetPacket } from './packet';
import type { DeepDiveResult } from './schema';

/** the three outcomes the deep-dive forecasts (spec §5) */
export const DEEPDIVE_OUTCOME_KEYS = {
  p_insider_exit_24h: 'INSIDER_EXIT@24h',
  p_drawdown_80_7d: 'DRAWDOWN_80@7d',
  p_sell_impaired_24h: 'SELL_IMPAIRED@24h',
} as const satisfies Record<string, OutcomeKey>;

export interface AssembleDeepdiveReportInput {
  chainId: number;
  tokenAddress: string;
  launchId: string | null;
  trigger: string;
  packet: TargetPacket;
  result: DeepDiveResult;
  /** the instance agent key; when absent the draft is unsigned and fails §8.3 */
  agentPrivateKey?: Hex;
}

export function assembleDeepdiveReport(input: AssembleDeepdiveReportInput): ReportDraft {
  const { packet, result } = input;
  const o = result.output;

  const blockPin: BlockPin = {
    number: Number(packet.reportBlock.number),
    hash: packet.reportBlock.hash,
    timestamp: packet.reportBlock.timestampUtc,
  };
  const reportTime = packet.reportBlock.timestampUtc;

  const content: ReportContent = {
    version: 'report/v0',
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    launchId: input.launchId,
    reportTime,
    trigger: input.trigger,
    blockPin,
    forecaster: 'llm_deepdive_v0',
    forecasterVersion: result.modelSlug,
    outcomeRuleVersion: 'v1',
    probabilities: {
      [DEEPDIVE_OUTCOME_KEYS.p_insider_exit_24h]: o.p_insider_exit_24h,
      [DEEPDIVE_OUTCOME_KEYS.p_drawdown_80_7d]: o.p_drawdown_80_7d,
      [DEEPDIVE_OUTCOME_KEYS.p_sell_impaired_24h]: o.p_sell_impaired_24h,
    },
    coverage: [
      ...result.limitations.map((l) => `${l.tool}: ${l.reason}`),
      ...(packet.chainIdMatches ? [] : [`chain id mismatch: rpc ${packet.rpcChainId} vs target ${packet.chainId}`]),
      ...result.warnings,
    ],
    confidence: o.confidence,
    evidence: o.evidence,
  };

  const cj = canonicalJson(content);
  const rh = reportHash(cj);

  const agentAddr = input.agentPrivateKey
    ? agentAddress(input.agentPrivateKey)
    : '0x0000000000000000000000000000000000000000';

  const draft: ReportDraft = {
    content,
    canonicalJson: cj,
    reportHash: rh,
    signature: null,
    signer: null,
    validatorPassed: false,
    validatorFailures: [],
  };
  const v = validateReport(draft, {
    expectedChainId: input.chainId,
    expectedToken: input.tokenAddress,
    agentAddress: agentAddr,
  });
  draft.validatorPassed = v.ok;
  draft.validatorFailures = v.failures;
  return draft;
}

/** Assemble + EIP-712 sign + re-validate (the signer identity check needs the signature). */
export async function assembleDeepdiveReportSigned(
  input: AssembleDeepdiveReportInput,
): Promise<ReportDraft> {
  const draft = assembleDeepdiveReport(input);
  if (!input.agentPrivateKey) return draft;

  const reportTimeSec = Math.floor(Date.parse(draft.content.reportTime) / 1000);
  const s = await signReportCommitment(input.agentPrivateKey, {
    reportHash: draft.reportHash,
    chainId: input.chainId,
    token: input.tokenAddress as Hex,
    reportTime: reportTimeSec,
    forecaster: 'llm_deepdive_v0',
  });
  draft.signature = s.signature;
  draft.signer = s.signer;

  const v = validateReport(draft, {
    expectedChainId: input.chainId,
    expectedToken: input.tokenAddress,
    agentAddress: agentAddress(input.agentPrivateKey),
  });
  draft.validatorPassed = v.ok;
  draft.validatorFailures = v.failures;
  return draft;
}
