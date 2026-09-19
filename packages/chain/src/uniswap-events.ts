import { decodeEventLog, parseAbiItem, toEventSelector, type Hex } from 'viem';

/**
 * Trade / liquidity events used by M4 outcome resolution. Pure decoders — no
 * network. v4 events are emitted by the PoolManager singleton and keyed by the
 * bytes32 pool id; v2/v3 events come from the individual pool contract.
 */

// ── v4 PoolManager ────────────────────────────────────────────────────
export const V4_SWAP = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
export const V4_MODIFY_LIQUIDITY = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
);

// ── v3 pool ───────────────────────────────────────────────────────────
export const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);
export const V3_BURN = parseAbiItem(
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
);

// ── v2 pair ───────────────────────────────────────────────────────────
export const V2_SYNC = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');
export const V2_SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

export const TRADE_EVENT_TOPIC0 = {
  v4Swap: toEventSelector(V4_SWAP),
  v4ModifyLiquidity: toEventSelector(V4_MODIFY_LIQUIDITY),
  v3Swap: toEventSelector(V3_SWAP),
  v3Burn: toEventSelector(V3_BURN),
  v2Sync: toEventSelector(V2_SYNC),
  v2Swap: toEventSelector(V2_SWAP),
} as const;

export interface RawEventLog {
  topics: string[];
  data: string;
  blockNumber?: string | bigint;
  transactionHash?: string;
}

const asTopics = (l: RawEventLog): [Hex, ...Hex[]] => l.topics as [Hex, ...Hex[]];
export const logBlock = (l: RawEventLog): bigint =>
  l.blockNumber === undefined ? 0n : BigInt(l.blockNumber);

export interface SwapObservation {
  block: bigint;
  txHash: string | null;
  /** sqrtPriceX96 (v3/v4 only); null for v2 */
  sqrtPriceX96: bigint | null;
  /** in-range liquidity reported by the event (v3/v4); null for v2 */
  liquidity: bigint | null;
  amount0: bigint;
  amount1: bigint;
}

export function decodeV4Swap(log: RawEventLog): SwapObservation | null {
  if (log.topics[0]?.toLowerCase() !== TRADE_EVENT_TOPIC0.v4Swap.toLowerCase()) return null;
  const { args } = decodeEventLog({ abi: [V4_SWAP], data: log.data as Hex, topics: asTopics(log) });
  return {
    block: logBlock(log),
    txHash: log.transactionHash ?? null,
    sqrtPriceX96: args.sqrtPriceX96,
    liquidity: args.liquidity,
    amount0: args.amount0,
    amount1: args.amount1,
  };
}

export function decodeV3Swap(log: RawEventLog): SwapObservation | null {
  if (log.topics[0]?.toLowerCase() !== TRADE_EVENT_TOPIC0.v3Swap.toLowerCase()) return null;
  const { args } = decodeEventLog({ abi: [V3_SWAP], data: log.data as Hex, topics: asTopics(log) });
  return {
    block: logBlock(log),
    txHash: log.transactionHash ?? null,
    sqrtPriceX96: args.sqrtPriceX96,
    liquidity: args.liquidity,
    amount0: args.amount0,
    amount1: args.amount1,
  };
}

export interface LiquidityDelta {
  block: bigint;
  txHash: string | null;
  /** signed change in liquidity; negative = removal */
  delta: bigint;
}

export function decodeV4ModifyLiquidity(log: RawEventLog): LiquidityDelta | null {
  if (log.topics[0]?.toLowerCase() !== TRADE_EVENT_TOPIC0.v4ModifyLiquidity.toLowerCase()) {
    return null;
  }
  const { args } = decodeEventLog({
    abi: [V4_MODIFY_LIQUIDITY],
    data: log.data as Hex,
    topics: asTopics(log),
  });
  return { block: logBlock(log), txHash: log.transactionHash ?? null, delta: args.liquidityDelta };
}

export interface SyncObservation {
  block: bigint;
  txHash: string | null;
  reserve0: bigint;
  reserve1: bigint;
}

export function decodeV2Sync(log: RawEventLog): SyncObservation | null {
  if (log.topics[0]?.toLowerCase() !== TRADE_EVENT_TOPIC0.v2Sync.toLowerCase()) return null;
  const { args } = decodeEventLog({ abi: [V2_SYNC], data: log.data as Hex, topics: asTopics(log) });
  return {
    block: logBlock(log),
    txHash: log.transactionHash ?? null,
    reserve0: args.reserve0,
    reserve1: args.reserve1,
  };
}

const Q96 = 2n ** 96n;

/**
 * Price of currency0 denominated in currency1, from a sqrtPriceX96. Uses a
 * high-precision bigint intermediate so tiny prices don't underflow to 0.
 * Decimals are NOT applied — callers that only need a ratio over time (drawdown)
 * can ignore them; a caller needing an absolute price must scale by
 * 10**(decimals0 - decimals1).
 */
export function sqrtPriceX96ToPrice0in1(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0;
  // (sqrtP / 2^96)^2, kept in bigint as long as possible
  const scaled = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96);
  return Number(scaled) / 1e18;
}

/** Price of `token` in quote units, given which currency slot the token holds. */
export function tokenPriceInQuote(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): number {
  const p0in1 = sqrtPriceX96ToPrice0in1(sqrtPriceX96);
  if (tokenIsCurrency0) return p0in1;
  return p0in1 > 0 ? 1 / p0in1 : 0;
}
