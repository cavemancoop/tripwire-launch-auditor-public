import config4663 from '../config/chain.4663.json';

export interface ContractRef {
  address: string;
  verified: boolean;
  evidence?: string;
  note?: string;
  alternates?: string[];
}

export interface LaunchpadConfig {
  key: string;
  label: string;
  model: string;
  lpLockedByConstruction: boolean;
  /** Confirmed factory / periphery addresses that identify this launchpad. */
  factories: string[];
  /** Unconfirmed candidates to check against a real launch tx. */
  candidateFactories?: string[];
  verified: boolean;
  tokenCreatedSignature?: string;
  evidence?: string;
  note?: string;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  explorer: string;
  blockscoutApi: string;
  approxBlockSeconds: number;
  getLogsMaxRange: number;
  launchpadVerificationMethod?: string;
  uniswap: {
    v4PoolManager: ContractRef;
    v3Factory: ContractRef;
    v2Factory: ContractRef;
    v4Quoter: ContractRef;
  };
  quoteAssets: { note?: string; usdg: string; weth: string; list: string[] };
  launchpads: LaunchpadConfig[];
}

export const chainConfigs: Record<number, ChainConfig> = {
  4663: config4663 as ChainConfig,
};

export function getChainConfig(chainId: number): ChainConfig {
  const cfg = chainConfigs[chainId];
  if (!cfg) throw new Error(`no chain config for chainId ${chainId}`);
  return cfg;
}

/**
 * Runtime override for the eth_getLogs block-span limit. The config JSON carries
 * a conservative default (`getLogsMaxRange`); on boot the worker probes the RPC's
 * real limit (M4 `packages/rpc-budget`) and calls `setGetLogsMaxRange` with it.
 * Every chunked scan reads through `getGetLogsMaxRange()` so the probed value
 * takes effect without threading it through call sites.
 */
let getLogsMaxRangeOverride: number | null = null;

export function setGetLogsMaxRange(blocks: number): void {
  if (Number.isFinite(blocks) && blocks >= 1) {
    getLogsMaxRangeOverride = Math.floor(blocks);
  }
}

export function getGetLogsMaxRange(chainId = 4663): number {
  return getLogsMaxRangeOverride ?? getChainConfig(chainId).getLogsMaxRange;
}

/** All Uniswap core addresses to poll for pool-creation, lowercased. */
export function poolCreationSources(chainId: number): {
  v2Factory: string;
  v3Factories: string[];
  v4PoolManager: string;
} {
  const u = getChainConfig(chainId).uniswap;
  return {
    v2Factory: u.v2Factory.address.toLowerCase(),
    v3Factories: [u.v3Factory.address, ...(u.v3Factory.alternates ?? [])].map((a) =>
      a.toLowerCase(),
    ),
    v4PoolManager: u.v4PoolManager.address.toLowerCase(),
  };
}
