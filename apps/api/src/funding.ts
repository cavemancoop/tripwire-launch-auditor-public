/**
 * `GET /v1/funding` — where the agent's inference money comes from, straight
 * from chain 4663. Every CREDIT activation whose beneficiary is the agent's
 * Orbio account is listed with its tx, so the dashboard can show "funded by the
 * operator's activation #58" as a checkable fact rather than a sentence.
 *
 * `from === account` = the agent activated CREDIT it held; anything else = an
 * operator (or anyone) activating into the agent's account. Read-only.
 */
import { createPublicClient, formatUnits, http, pad, parseAbiItem, type Hex } from 'viem';
import type { ApiEnv } from './env';

export interface FundingActivation {
  activationId: string;
  amountUsd: number;
  from: string;
  by: 'agent' | 'operator';
  blockNumber: number;
  at: string | null;
  txHash: string;
}

export interface FundingSummary {
  configured: boolean;
  account: string | null;
  creditAddress: string | null;
  fromBlock: number | null;
  totalActivatedUsd: number;
  byOperatorUsd: number;
  byAgentUsd: number;
  /** property 2 (2026-09-16): Σ activated in the trailing 24h, any funder —
   *  the same figure the worker's dailyDeepdiveBudget() derives its
   *  credit_share term from. Reuses this reader's own cached scan, no extra RPC. */
  trailingCreditsUsd: number;
  activations: FundingActivation[];
}

export type FundingReader = () => Promise<FundingSummary>;

const ACTIVATED = parseAbiItem(
  'event Activated(uint256 indexed activationId, address indexed from, bytes32 indexed beneficiary, uint256 amount)',
);

const EMPTY: Omit<FundingSummary, 'configured'> = {
  account: null,
  creditAddress: null,
  fromBlock: null,
  totalActivatedUsd: 0,
  byOperatorUsd: 0,
  byAgentUsd: 0,
  trailingCreditsUsd: 0,
  activations: [],
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function summarizeFunding(
  account: string,
  rows: Omit<FundingActivation, 'by'>[],
  nowMs: number = Date.now(),
): Pick<FundingSummary, 'totalActivatedUsd' | 'byOperatorUsd' | 'byAgentUsd' | 'trailingCreditsUsd' | 'activations'> {
  const activations = rows
    .map((r) => ({ ...r, by: (r.from.toLowerCase() === account.toLowerCase() ? 'agent' : 'operator') as FundingActivation['by'] }))
    .sort((a, b) => b.blockNumber - a.blockNumber);
  const sum = (by?: FundingActivation['by']) => round6(activations.filter((a) => !by || a.by === by).reduce((s, a) => s + a.amountUsd, 0));
  const cutoffMs = nowMs - 86_400_000;
  const trailingCreditsUsd = round6(
    activations.filter((a) => a.at !== null && Date.parse(a.at) >= cutoffMs).reduce((s, a) => s + a.amountUsd, 0),
  );
  return { activations, totalActivatedUsd: sum(), byOperatorUsd: sum('operator'), byAgentUsd: sum('agent'), trailingCreditsUsd };
}

/**
 * Incremental scan cached in memory: the first call walks from
 * `ORBIO_FUNDING_FROM_BLOCK`, later calls only the new blocks, at most once a
 * minute. A restart rescans from the configured block, which is cheap while the
 * account's history is days old.
 */
export function chainFundingReader(env: ApiEnv): FundingReader {
  const account = env.orbioAgentAccount;
  const credit = env.orbioCreditAddress;
  const fromBlock = env.fundingFromBlock;
  if (!account || !credit || fromBlock == null || !env.rpcUrl) {
    return async () => ({ configured: false, ...EMPTY });
  }
  const client = createPublicClient({ transport: http(env.rpcUrl, { timeout: 20_000 }) });
  const beneficiary = pad(account.toLowerCase() as Hex, { size: 32 });
  const rows: Omit<FundingActivation, 'by'>[] = [];
  let scannedTo = BigInt(fromBlock) - 1n;
  let lastRefresh = 0;
  let inflight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    const head = await client.getBlockNumber();
    let from = scannedTo + 1n;
    while (from <= head) {
      const to = from + 9_998n > head ? head : from + 9_998n;
      const logs = await client.getLogs({ address: credit, event: ACTIVATED, args: { beneficiary }, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const block = await client.getBlock({ blockNumber: l.blockNumber }).catch(() => null);
        rows.push({
          activationId: (l.args.activationId ?? 0n).toString(),
          amountUsd: Number(formatUnits(l.args.amount ?? 0n, 6)),
          from: l.args.from ?? '',
          blockNumber: Number(l.blockNumber),
          at: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
          txHash: l.transactionHash,
        });
      }
      scannedTo = to;
      from = to + 1n;
    }
    lastRefresh = Date.now();
  };

  return async () => {
    if (Date.now() - lastRefresh > 60_000) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return { configured: true, account, creditAddress: credit, fromBlock, ...summarizeFunding(account, rows) };
  };
}
