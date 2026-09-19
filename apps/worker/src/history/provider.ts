/**
 * Address transfer history, behind an interface so a real index (self-hosted
 * Blockscout, Bitquery, an archive indexer) can slot in later without touching
 * callers (checkpoint §8.1). The RPC-logs implementation
 * (`rpc-logs.ts`) covers ERC-20 transfers only — not native-ETH funding — so it
 * is enough for M6's address-activity tool but NOT for a true creator-cluster
 * rule 4 (first-ever inbound), which stays disabled until an indexer exists.
 */
export interface TokenTransfer {
  token: string;
  from: string;
  to: string;
  value: bigint;
  block: bigint;
  logIndex: number;
  txHash: string | null;
}

export interface HistoryWindow {
  /** optional single-token filter; omit to scan every contract's Transfer logs
   *  (expensive — the caller MUST keep the block window small) */
  token?: string;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface AddressHistoryProvider {
  /** ERC-20 transfers into `address` in the window, oldest first */
  inboundTransfers(address: string, w: HistoryWindow): Promise<TokenTransfer[]>;
  /** ERC-20 transfers out of `address` in the window, oldest first */
  outboundTransfers(address: string, w: HistoryWindow): Promise<TokenTransfer[]>;
  /** every ERC-20 transfer touching `address` (in or out), oldest first */
  tokenActivity(address: string, w: HistoryWindow): Promise<TokenTransfer[]>;
  /** sender of the earliest ERC-20 inbound transfer to `address` in the window;
   *  best-effort — misses native-ETH funding, so not a substitute for a real
   *  first-inbound index */
  firstErc20Funder(address: string, w: Omit<HistoryWindow, 'token'>): Promise<string | null>;
}

/** Adapter to the creator-cluster `FirstInboundLookup` shape. NOT wired by
 *  default (Fable: ship rule 4 disabled) — provided so an indexer-backed
 *  provider can enable it later. */
export function toFirstInboundLookup(
  provider: AddressHistoryProvider,
  window: Omit<HistoryWindow, 'token'>,
): { firstFunder(address: string): Promise<string | null> } {
  return { firstFunder: (address) => provider.firstErc20Funder(address, window) };
}
