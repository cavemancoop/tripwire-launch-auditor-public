import type { PublicClient } from 'viem';
import type { PoolKey } from './quote';
import type { LogClient, PoolRef } from './series';

/** Everything a per-label resolver needs, assembled once by the dispatcher. */
export interface ResolverContext {
  client: LogClient & Pick<PublicClient, 'request'>;
  chainId: number;
  maxRange: number;

  pool: PoolRef;
  token: string; // lowercased new-token address
  quote: string; // lowercased paired-asset address (may be the zero address)
  poolKey: PoolKey | null; // v4 only; for the Quoter
  quoter: string;
  /** decimals of the paired asset, for the SELL_IMPAIRED notional (100 quote units) */
  quoteDecimals: number;

  launchBlock: bigint;
  lpLockedByConstruction: boolean;
  clusterWallets: string[]; // lowercased

  // per-outcome
  label: string;
  horizon: string;
  trigger: string;
  anchorBlock: bigint;
  horizonBlock: bigint;

  // DRAWDOWN_80 reference window (spec §1.1)
  drawdownRefStart: bigint;
  drawdownRefEnd: bigint;
}
