import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
} from 'viem';

export const RH_CHAIN_ID = 4663;

/**
 * Robinhood Chain (id 4663). RPC URLs are supplied at call time from env
 * (RH_RPC_URL / RH_RPC_ARCHIVE_URL) — never hardcoded here.
 */
export const robinhoodChain = defineChain({
  id: RH_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

export interface PublicClientOptions {
  /** per-request timeout in ms (default 30_000 — ordofi can be slow under load) */
  timeout?: number;
  /** transport-level retries on transient failures (default 5) */
  retryCount?: number;
  retryDelay?: number;
}

export function getPublicClient(
  rpcUrl: string,
  opts: PublicClientOptions = {},
): PublicClient {
  if (!rpcUrl) {
    throw new Error('getPublicClient: rpcUrl is empty (set RH_RPC_URL)');
  }
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl, {
      timeout: opts.timeout ?? 30_000,
      retryCount: opts.retryCount ?? 5,
      retryDelay: opts.retryDelay ?? 400,
    }),
  });
}
