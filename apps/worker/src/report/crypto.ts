import type { OutcomeKey } from '@launch-auditor/scoring';
import canonicalize from 'canonicalize';
import {
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// RFC 8785 canonical JSON + keccak256, and EIP-712 signing of the report
// commitment (spec §6). We sign a compact struct whose `reportHash` binds the
// full canonical content; the hash is also what gets Merkle-committed.

export function canonicalJson(obj: unknown): string {
  const s = canonicalize(obj as object);
  if (s === undefined) throw new Error('canonicalize returned undefined');
  return s;
}

export function reportHash(canonical: string): Hex {
  return keccak256(stringToHex(canonical));
}

export const EIP712_DOMAIN_NAME = 'LaunchAuditor';
export const EIP712_DOMAIN_VERSION = '1';

const TYPES = {
  ReportCommitment: [
    { name: 'reportHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'reportTime', type: 'uint64' },
    { name: 'forecaster', type: 'string' },
  ],
} as const;

export interface ReportCommitmentMessage {
  reportHash: Hex;
  chainId: number;
  token: Hex;
  /** unix seconds */
  reportTime: number;
  forecaster: string;
}

function domain(chainId: number) {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId } as const;
}

function message(m: ReportCommitmentMessage) {
  return {
    reportHash: m.reportHash,
    chainId: BigInt(m.chainId),
    token: m.token,
    reportTime: BigInt(m.reportTime),
    forecaster: m.forecaster,
  };
}

export function agentAddress(privateKey: Hex): Hex {
  return privateKeyToAccount(privateKey).address;
}

export async function signReportCommitment(
  privateKey: Hex,
  m: ReportCommitmentMessage,
): Promise<{ signature: Hex; signer: Hex }> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: domain(m.chainId),
    types: TYPES,
    primaryType: 'ReportCommitment',
    message: message(m),
  });
  return { signature, signer: account.address };
}

export function recoverReportSigner(
  m: ReportCommitmentMessage,
  signature: Hex,
): Promise<Hex> {
  return recoverTypedDataAddress({
    domain: domain(m.chainId),
    types: TYPES,
    primaryType: 'ReportCommitment',
    message: message(m),
    signature,
  });
}

/** OutcomeKey -> the Prisma Report column that holds its probability (the §1 cells). */
export const OUTCOME_COLUMN: Partial<Record<OutcomeKey, string>> = {
  'INSIDER_EXIT@6h': 'pInsiderExit6h',
  'INSIDER_EXIT@24h': 'pInsiderExit24h',
  'INSIDER_EXIT@72h': 'pInsiderExit72h',
  'SELL_IMPAIRED@1h': 'pSellImpaired1h',
  'SELL_IMPAIRED@24h': 'pSellImpaired24h',
  'LIQ_IMPAIRED@24h': 'pLiqImpaired24h',
  'LIQ_IMPAIRED@7d': 'pLiqImpaired7d',
  'DRAWDOWN_80@24h': 'pDrawdown80_24h',
  'DRAWDOWN_80@7d': 'pDrawdown80_7d',
  'TRADING_ALIVE@24h': 'pTradingAlive24h',
  'TRADING_ALIVE@7d': 'pTradingAlive7d',
};

export function probabilitiesToColumns(
  p: Partial<Record<OutcomeKey, number>>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [key, col] of Object.entries(OUTCOME_COLUMN)) {
    out[col] = p[key as OutcomeKey] ?? null;
  }
  return out;
}
