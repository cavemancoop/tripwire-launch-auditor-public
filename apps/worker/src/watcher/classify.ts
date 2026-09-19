import { getChainConfig } from '@launch-auditor/chain';

/** Uniswap v4 uses the zero address for native ETH — always a quote, never the new token. */
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

export interface PairClassification {
  /** the new token */
  token: string;
  /** the paired asset, or null when it can't be told apart */
  quote: string | null;
  /** true only when a configured quote asset matched */
  confident: boolean;
}

/**
 * Decide which side of a freshly-created pool is the new token and which is the
 * quote asset. M1 heuristic: a match against a configured quote asset is
 * confident; otherwise assume token1 is the new token (Uniswap orders currencies
 * by address, so this is a coin-flip — M2 disambiguates by contract creation
 * block).
 */
export function classifyPair(
  chainId: number,
  token0: string,
  token1: string,
): PairClassification {
  const quotes = new Set([
    NATIVE_ETH,
    ...getChainConfig(chainId).quoteAssets.list.map((a) => a.toLowerCase()),
  ]);
  const a0 = token0.toLowerCase();
  const a1 = token1.toLowerCase();

  if (quotes.has(a0) && !quotes.has(a1)) return { token: token1, quote: token0, confident: true };
  if (quotes.has(a1) && !quotes.has(a0)) return { token: token0, quote: token1, confident: true };

  return { token: token1, quote: token0, confident: false };
}
