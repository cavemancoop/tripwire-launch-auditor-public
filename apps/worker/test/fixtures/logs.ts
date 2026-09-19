import { V4_MODIFY_LIQUIDITY, V4_SWAP } from '@launch-auditor/chain';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from 'viem';
import { addressToTopic, TRANSFER_TOPIC0 } from '../../src/watcher/erc20';

const SENDER = '0x00000000000000000000000000000000000000aa';

/** viem 2.56 has no encodeEventLog; build {topics,data} from the parsed event. */
export function encodeLog(
  event: AbiEvent,
  args: Record<string, unknown>,
): { topics: string[]; data: Hex } {
  const indexed = Object.fromEntries(
    event.inputs.filter((i) => i.indexed && i.name).map((i) => [i.name as string, args[i.name!]]),
  );
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: indexed }) as string[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length
    ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]))
    : '0x';
  return { topics, data };
}

/** uint256/int256 -> 32-byte hex (two's complement for negatives) */
export const word = (n: bigint): string =>
  `0x${(n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0')}`;

export const transferLog = (
  token: string,
  from: string,
  to: string,
  value: bigint,
  block: bigint,
  logIndex = 0,
) => ({
  address: token,
  topics: [TRANSFER_TOPIC0, addressToTopic(from), addressToTopic(to)] as string[],
  data: word(value),
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  transactionHash: `0x${'ab'.repeat(32)}`,
});

export const v4SwapLog = (poolId: Hex, sqrtPriceX96: bigint, block: bigint, liquidity = 0n) => {
  const { topics, data } = encodeLog(V4_SWAP, {
    id: poolId,
    sender: SENDER,
    amount0: -1n,
    amount1: 1n,
    sqrtPriceX96,
    liquidity,
    tick: 0,
    fee: 3000,
  });
  return {
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${'cd'.repeat(32)}`,
    logIndex: '0x0',
  };
};

export const v4ModLiqLog = (poolId: Hex, delta: bigint, block: bigint) => {
  const { topics, data } = encodeLog(V4_MODIFY_LIQUIDITY, {
    id: poolId,
    sender: SENDER,
    tickLower: -60,
    tickUpper: 60,
    liquidityDelta: delta,
    salt: `0x${'00'.repeat(32)}` as Hex,
  });
  return {
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${'ef'.repeat(32)}`,
    logIndex: '0x0',
  };
};

/** sqrtPriceX96 ≈ sqrt(price) * 2^96, staged to avoid float overflow at 2^96 */
export const sqrtForPrice = (price: number): bigint =>
  (BigInt(Math.round(Math.sqrt(price) * 1e9)) * 2n ** 96n) / 10n ** 9n;

/** ABI-encoded (uint256 amountOut, uint256 gasEstimate) quoter return */
export const encodeQuoterReturn = (out: bigint): Hex =>
  `0x${out.toString(16).padStart(64, '0')}${(21_000n).toString(16).padStart(64, '0')}` as Hex;
