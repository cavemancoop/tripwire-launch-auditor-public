/**
 * `GET /v1/receipt/:hash` — one forecast, provable end to end without trusting
 * this server (2026-09-19 audit, fix 3). `/v1/proof` showed that *a* hash was
 * in a committed batch; it didn't show that the displayed forecast produced
 * that hash. The receipt serves the exact canonical bytes that were hashed, the
 * EIP-712 message and signature over that hash, the Merkle proof, the commit's
 * **chain** block time, and every outcome for the same anchor with its
 * eligibility class. `pnpm verify:receipt <hash>` recomputes each link locally.
 */
import { prisma } from '@launch-auditor/db';
import { classifyEligibility, horizonToMs, type Eligibility } from '@launch-auditor/scoring';
import { createPublicClient, http } from 'viem';
import type { ApiEnv } from './env';

export const EIP712_DOMAIN_NAME = 'LaunchAuditor';
export const EIP712_DOMAIN_VERSION = '1';
export const REPORT_COMMITMENT_TYPES = {
  ReportCommitment: [
    { name: 'reportHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'reportTime', type: 'uint64' },
    { name: 'forecaster', type: 'string' },
  ],
} as const;

export interface ReceiptOutcome {
  label: string;
  horizon: string;
  status: string;
  value: boolean | null;
  horizonEnd: string;
  /** whether this forecast may count toward a claim on this outcome */
  eligibility: Eligibility;
}

export interface Receipt {
  reportHash: string;
  /** the exact string whose keccak256 is reportHash — verify byte for byte */
  canonicalJson: string;
  content: unknown;
  signature: string | null;
  signer: string | null;
  eip712: {
    domain: { name: string; version: string; chainId: number };
    types: typeof REPORT_COMMITMENT_TYPES;
    primaryType: 'ReportCommitment';
    /** reportTime in unix seconds, as signed */
    message: { reportHash: string; chainId: number; token: string; reportTime: number; forecaster: string };
  };
  commit: {
    committed: boolean;
    registry: string | null;
    txHash: string | null;
    blockNumber: number | null;
    /** the block's own timestamp, read from chain — not the server's receipt-recording time */
    blockTime: string | null;
    merkleRoot: string | null;
    leafIndex: number | null;
    proof: string[] | null;
    /** seconds from the report's anchor (reportTime) to blockTime */
    lagFromAnchorSec: number | null;
  };
  outcomes: ReceiptOutcome[];
  verify: string;
}

interface StoredLeaf {
  reportHash: string;
  index: number;
  proof: string[];
}

export interface ReceiptRow {
  reportHash: string;
  canonicalJson: string;
  eip712Signature: string | null;
  signerAddress: string | null;
  chainId: number;
  tokenAddress: string;
  reportTime: Date;
  forecaster: string;
  commit: { txHash: string | null; blockNumber: bigint | null; merkleRoot: string; leaves: unknown } | null;
}

export interface ReceiptOutcomeRow {
  label: string;
  horizon: string;
  status: string;
  value: boolean | null;
}

/** Pure: assemble the receipt from stored rows plus the chain's block time. */
export function buildReceipt(
  row: ReceiptRow,
  outcomes: ReceiptOutcomeRow[],
  blockTime: Date | null,
  registry: string | null,
): Receipt {
  const leaf = row.commit
    ? ((row.commit.leaves as StoredLeaf[] | null) ?? []).find((l) => l.reportHash.toLowerCase() === row.reportHash.toLowerCase())
    : undefined;
  const committed = row.commit != null && row.commit.blockNumber != null;
  let content: unknown = null;
  try {
    content = JSON.parse(row.canonicalJson);
  } catch {
    content = null;
  }
  return {
    reportHash: row.reportHash,
    canonicalJson: row.canonicalJson,
    content,
    signature: row.eip712Signature,
    signer: row.signerAddress,
    eip712: {
      domain: { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: row.chainId },
      types: REPORT_COMMITMENT_TYPES,
      primaryType: 'ReportCommitment',
      message: {
        reportHash: row.reportHash,
        chainId: row.chainId,
        token: row.tokenAddress,
        reportTime: Math.floor(row.reportTime.getTime() / 1000),
        forecaster: row.forecaster,
      },
    },
    commit: {
      committed,
      registry,
      txHash: row.commit?.txHash ?? null,
      blockNumber: row.commit?.blockNumber != null ? Number(row.commit.blockNumber) : null,
      blockTime: blockTime?.toISOString() ?? null,
      merkleRoot: row.commit?.merkleRoot ?? null,
      leafIndex: leaf?.index ?? null,
      proof: leaf?.proof ?? null,
      lagFromAnchorSec: blockTime ? Math.round((blockTime.getTime() - row.reportTime.getTime()) / 1000) : null,
    },
    outcomes: outcomes.map((o) => {
      const horizonEnd = new Date(row.reportTime.getTime() + horizonToMs(o.horizon));
      return {
        label: o.label,
        horizon: o.horizon,
        status: o.status,
        value: o.value,
        horizonEnd: horizonEnd.toISOString(),
        eligibility: classifyEligibility({ reportTime: row.reportTime, committed, commitBlockTime: blockTime, horizonEnd }),
      };
    }),
    verify:
      'pnpm verify:receipt <reportHash> — recomputes keccak256(canonicalJson), recovers the EIP-712 signer, ' +
      'folds the Merkle proof to the root, and reads the BatchCommitted event and block time from any RPC.',
  };
}

export type ReceiptReader = (hash: string) => Promise<Receipt | null>;

export function prismaReceiptReader(env: ApiEnv): ReceiptReader {
  const blockTimes = new Map<string, Date>();
  const client = env.rpcUrl ? createPublicClient({ transport: http(env.rpcUrl, { timeout: 15_000 }) }) : null;
  const blockTimeOf = async (blockNumber: bigint): Promise<Date | null> => {
    const k = blockNumber.toString();
    const hit = blockTimes.get(k);
    if (hit) return hit;
    if (!client) return null;
    try {
      const b = await client.getBlock({ blockNumber });
      const t = new Date(Number(b.timestamp) * 1000);
      blockTimes.set(k, t);
      return t;
    } catch {
      return null; // shown as unknown, never guessed
    }
  };

  return async (hash) => {
    const r = await prisma.report.findUnique({
      where: { reportHash: hash },
      include: { commit: { select: { txHash: true, blockNumber: true, merkleRoot: true, leaves: true } } },
    });
    if (!r) return null;
    const outcomes = await prisma.outcome.findMany({
      where: { chainId: r.chainId, tokenAddress: r.tokenAddress, anchorTime: r.reportTime },
      orderBy: [{ label: 'asc' }, { horizon: 'asc' }],
      select: { label: true, horizon: true, status: true, value: true },
    });
    const blockTime = r.commit?.blockNumber != null ? await blockTimeOf(r.commit.blockNumber) : null;
    return buildReceipt(r, outcomes, blockTime, env.commitRegistryAddress ?? null);
  };
}
