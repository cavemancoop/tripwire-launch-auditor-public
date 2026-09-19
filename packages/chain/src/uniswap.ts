import {
  decodeEventLog,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
} from 'viem';

// ── Pool-creation events across Uniswap v2 / v3 / v4 ────────────────────

export const UNISWAP_V2_PAIR_CREATED = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
);

export const UNISWAP_V3_POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);

export const UNISWAP_V4_INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

/** topic0 for each pool-creation event (computed, not hardcoded). */
export const POOL_EVENT_TOPIC0 = {
  v2PairCreated: toEventSelector(UNISWAP_V2_PAIR_CREATED),
  v3PoolCreated: toEventSelector(UNISWAP_V3_POOL_CREATED),
  v4Initialize: toEventSelector(UNISWAP_V4_INITIALIZE),
} as const;

export type PoolKind = 'v2' | 'v3' | 'v4';

export interface PoolCreation {
  poolKind: PoolKind;
  detectedVia: `${PoolKind}:${string}`;
  token0: Address;
  token1: Address;
  poolAddress: Address | null; // v2/v3 pool contract
  poolId: Hex | null; // v4 bytes32 pool id
  fee: number | null;
  tickSpacing: number | null;
  hooks: Address | null; // v4 only; zero address when none
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Decode a log into a PoolCreation, or null if its topic0 is not one of the
 * three pool-creation events. Pure; no network.
 */
export function decodePoolCreation(log: RawLog): PoolCreation | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return null;
  const topics = log.topics as [Hex, ...Hex[]];
  const data = log.data as Hex;

  if (topic0 === POOL_EVENT_TOPIC0.v4Initialize.toLowerCase()) {
    const { args } = decodeEventLog({ abi: [UNISWAP_V4_INITIALIZE], data, topics });
    return {
      poolKind: 'v4',
      detectedVia: 'v4:Initialize',
      token0: args.currency0,
      token1: args.currency1,
      poolAddress: null,
      poolId: args.id,
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      hooks: args.hooks,
    };
  }

  if (topic0 === POOL_EVENT_TOPIC0.v3PoolCreated.toLowerCase()) {
    const { args } = decodeEventLog({ abi: [UNISWAP_V3_POOL_CREATED], data, topics });
    return {
      poolKind: 'v3',
      detectedVia: 'v3:PoolCreated',
      token0: args.token0,
      token1: args.token1,
      poolAddress: args.pool,
      poolId: null,
      fee: Number(args.fee),
      tickSpacing: Number(args.tickSpacing),
      hooks: null,
    };
  }

  if (topic0 === POOL_EVENT_TOPIC0.v2PairCreated.toLowerCase()) {
    const { args } = decodeEventLog({ abi: [UNISWAP_V2_PAIR_CREATED], data, topics });
    return {
      poolKind: 'v2',
      detectedVia: 'v2:PairCreated',
      token0: args.token0,
      token1: args.token1,
      poolAddress: args.pair,
      poolId: null,
      fee: null,
      tickSpacing: null,
      hooks: null,
    };
  }

  return null;
}

/** True when the address is the zero address (no v4 hook). */
export function isZeroAddress(addr: string | null | undefined): boolean {
  return !addr || addr.toLowerCase() === ZERO_ADDRESS;
}
