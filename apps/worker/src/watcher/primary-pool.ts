import {
  decodePoolCreation,
  getChainConfig,
  getLogsChunked,
  POOL_EVENT_TOPIC0,
  TRADE_EVENT_TOPIC0,
} from '@launch-auditor/chain';
import type { Hex } from 'viem';
import { addressToTopic } from './erc20';
import { withRetry } from './retry';

// A token can have several v4 pools — the real trading pair plus decoy /
// token-vs-token / fee-tier side pools. The watcher used to keep whichever
// Initialize it saw first, which on 4663 is often a >10%-fee junk pool with no
// trades, so every downstream price / liquidity / sell resolution failed. Spec:
// the primary pool is the one paired with a known quote asset (USDG / WETH /
// native ETH) with the most activity; re-evaluated at report time.

const NATIVE = '0x0000000000000000000000000000000000000000';

/** v4 fee is in hundredths of a bip (1e-6). 10% = 100_000. Real pools are far below. */
export const FEE_SUSPECT_THRESHOLD = 100_000;
/** canonical Uniswap fee tiers (+ a few pad variants seen on 4663) */
const STANDARD_FEES = new Set([100, 200, 300, 400, 500, 2500, 3000, 5000, 10000, 20000, 30000]);

export function isFeeSuspect(fee: number | null | undefined): boolean {
  return fee != null && fee >= FEE_SUSPECT_THRESHOLD;
}

export interface PoolCandidate {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  initBlock: bigint;
  quote: string | null;
  quoteIsKnown: boolean;
  feeSuspect: boolean;
  standardFee: boolean;
  /** swap count in the scored window — activity proxy for "highest liquidity" */
  activity?: number;
}

type LogClient = Parameters<typeof getLogsChunked>[0];

/** Chain head, or null if the RPC won't say — a clamp we can't compute is
 *  better skipped than guessed, and the unclamped call still works on RPCs
 *  that tolerate past-head windows. */
async function readHeadBlock(client: LogClient): Promise<bigint | null> {
  try {
    const hex = (await client.request({ method: 'eth_blockNumber' } as never)) as unknown as string;
    return BigInt(hex);
  } catch {
    return null;
  }
}

function knownQuotes(chainId: number): Set<string> {
  const q = getChainConfig(chainId).quoteAssets;
  return new Set([NATIVE, q.usdg.toLowerCase(), q.weth.toLowerCase(), ...q.list.map((a) => a.toLowerCase())]);
}

/** annotate a raw candidate: which side is the (known) quote, fee sanity. */
export function annotate(c: Omit<PoolCandidate, 'quote' | 'quoteIsKnown' | 'feeSuspect' | 'standardFee'>, chainId: number): PoolCandidate {
  const known = knownQuotes(chainId);
  const c0 = c.currency0.toLowerCase();
  const c1 = c.currency1.toLowerCase();
  let quote: string | null = null;
  if (known.has(c0)) quote = c0;
  else if (known.has(c1)) quote = c1;
  return {
    ...c,
    quote,
    quoteIsKnown: quote !== null,
    feeSuspect: isFeeSuspect(c.fee),
    standardFee: c.fee != null && STANDARD_FEES.has(c.fee),
  };
}

/** Every v4 pool the token holds a currency slot in, over [fromBlock, toBlock]. */
export async function findTokenV4Pools(
  client: LogClient,
  chainId: number,
  token: string,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<PoolCandidate[]> {
  const pm = getChainConfig(chainId).uniswap.v4PoolManager.address as Hex;
  const tk = addressToTopic(token);
  const initTopic = POOL_EVENT_TOPIC0.v4Initialize as Hex;
  const [asC0, asC1] = await Promise.all([
    withRetry(() => getLogsChunked(client, { address: pm, topics: [initTopic, null, tk], fromBlock, toBlock, maxRange }), { tries: 3, delayMs: 2000 }),
    withRetry(() => getLogsChunked(client, { address: pm, topics: [initTopic, null, null, tk], fromBlock, toBlock, maxRange }), { tries: 3, delayMs: 2000 }),
  ]);
  const byId = new Map<string, PoolCandidate>();
  for (const log of [...asC0, ...asC1]) {
    const pc = decodePoolCreation(log);
    if (!pc?.poolId) continue;
    const id = pc.poolId.toLowerCase();
    if (byId.has(id)) continue;
    byId.set(
      id,
      annotate(
        {
          poolId: id,
          currency0: pc.token0.toLowerCase(),
          currency1: pc.token1.toLowerCase(),
          fee: pc.fee,
          tickSpacing: pc.tickSpacing,
          hooks: pc.hooks ? pc.hooks.toLowerCase() : null,
          initBlock: BigInt(log.blockNumber),
        },
        chainId,
      ),
    );
  }
  return [...byId.values()];
}

/** swap count for one v4 poolId in [fromBlock, toBlock] — the activity proxy. */
async function poolActivity(
  client: LogClient,
  chainId: number,
  poolId: string,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<number> {
  const pm = getChainConfig(chainId).uniswap.v4PoolManager.address as Hex;
  try {
    const logs = await withRetry(
      () =>
        getLogsChunked(client, {
          address: pm,
          topics: [TRADE_EVENT_TOPIC0.v4Swap as Hex, poolId as Hex],
          fromBlock,
          toBlock,
          maxRange,
        }),
      { tries: 2, delayMs: 1500 },
    );
    return logs.length;
  } catch {
    return 0;
  }
}

/**
 * Rank order (most-primary first):
 *  1. paired with a known quote asset
 *  2. fee not suspect (< 10%)
 *  3. standard fee tier
 *  4. more activity (swap count) — only probed when there's a real contest
 *  5. earlier init block
 */
export function rankCandidates(cands: PoolCandidate[]): PoolCandidate[] {
  return [...cands].sort((a, b) => {
    if (a.quoteIsKnown !== b.quoteIsKnown) return a.quoteIsKnown ? -1 : 1;
    if (a.feeSuspect !== b.feeSuspect) return a.feeSuspect ? 1 : -1;
    if (a.standardFee !== b.standardFee) return a.standardFee ? -1 : 1;
    const aa = a.activity ?? -1;
    const ba = b.activity ?? -1;
    if (aa !== ba) return ba - aa;
    return a.initBlock < b.initBlock ? -1 : a.initBlock > b.initBlock ? 1 : 0;
  });
}

export interface PrimaryPoolPick {
  chosen: PoolCandidate | null;
  /** the pick differs from the launch's current poolId */
  changed: boolean;
  reason: string;
  candidates: PoolCandidate[];
}

/**
 * Re-derive the primary v4 pool for a launch's token. `windowBlocks` bounds the
 * Initialize scan (launch → +~24h); `activityWindow` bounds the swap-count probe
 * (the scored T+10m window). The probe runs only when ≥2 known-quote candidates
 * survive the free ranking — the usual single-pool case costs nothing extra.
 */
export async function pickPrimaryV4Pool(
  client: LogClient,
  args: {
    chainId: number;
    token: string;
    currentPoolId: string | null;
    scanFrom: bigint;
    scanTo: bigint;
    activityFrom: bigint;
    activityTo: bigint;
    maxRange: number;
    /** current chain head; fetched when omitted. Callers that already know it
     *  should pass it rather than pay another round-trip. */
    headBlock?: bigint;
  },
): Promise<PrimaryPoolPick> {
  // Both windows run *forward* from the launch block (+2h for Initialize,
  // +10m for activity), so on a fresh launch they reach past the chain head —
  // on chain 4663 (0.1s blocks) the Initialize scan is 72k blocks, i.e. ~7 of
  // its 8 chunks sit entirely in the future. Some RPCs clamp that silently
  // (blockmachine); Chainstack rejects it outright with "invalid block range
  // params", which aborted the whole check and left every launch on whatever
  // pool the watcher first latched onto. Clamp to head so the query only ever
  // asks for blocks that exist.
  const head = args.headBlock ?? (await readHeadBlock(client));
  const scanTo = head !== null && args.scanTo > head ? head : args.scanTo;
  const activityTo = head !== null && args.activityTo > head ? head : args.activityTo;

  const cands = await findTokenV4Pools(client, args.chainId, args.token, args.scanFrom, scanTo, args.maxRange);
  if (cands.length === 0) {
    return { chosen: null, changed: false, reason: 'no v4 Initialize found for token in window', candidates: [] };
  }

  let ranked = rankCandidates(cands);
  const contenders = ranked.filter((c) => c.quoteIsKnown && !c.feeSuspect);
  if (contenders.length >= 2) {
    await Promise.all(
      contenders.slice(0, 4).map(async (c) => {
        c.activity = await poolActivity(client, args.chainId, c.poolId, args.activityFrom, activityTo, args.maxRange);
      }),
    );
    ranked = rankCandidates(cands);
  }

  const chosen = ranked[0]!;
  const cur = args.currentPoolId?.toLowerCase() ?? null;
  const changed = cur !== chosen.poolId;
  const reason = [
    changed ? `switch ${cur ?? 'none'} -> ${chosen.poolId}` : `keep ${chosen.poolId}`,
    chosen.quoteIsKnown ? `quote=${chosen.quote}` : 'quote=unknown',
    chosen.feeSuspect ? `FEE_SUSPECT(${chosen.fee})` : `fee=${chosen.fee}`,
    chosen.activity !== undefined ? `swaps10m=${chosen.activity}` : '',
    `${cands.length} candidate(s)`,
  ]
    .filter(Boolean)
    .join(' · ');
  return { chosen, changed, reason, candidates: ranked };
}
