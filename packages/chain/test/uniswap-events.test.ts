import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from 'viem';
import {
  V4_MODIFY_LIQUIDITY,
  V4_SWAP,
  V2_SYNC,
  decodeV2Sync,
  decodeV4ModifyLiquidity,
  decodeV4Swap,
  sqrtPriceX96ToPrice0in1,
  tokenPriceInQuote,
} from '../src/uniswap-events';

/** viem 2.56 has no encodeEventLog — build {topics,data} from the parsed event. */
function encodeLog(event: AbiEvent, args: Record<string, unknown>): { topics: string[]; data: Hex } {
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

const POOL_ID = `0x${'11'.repeat(32)}` as Hex;
const SENDER = '0x00000000000000000000000000000000000000aa';

describe('sqrtPriceX96 price math', () => {
  it('price 1 at sqrtPriceX96 = 2^96', () => {
    expect(sqrtPriceX96ToPrice0in1(2n ** 96n)).toBeCloseTo(1, 6);
  });
  it('price 4 at double the sqrt price', () => {
    expect(sqrtPriceX96ToPrice0in1(2n ** 97n)).toBeCloseTo(4, 4);
  });
  it('inverts for currency1', () => {
    expect(tokenPriceInQuote(2n ** 97n, true)).toBeCloseTo(4, 4);
    expect(tokenPriceInQuote(2n ** 97n, false)).toBeCloseTo(0.25, 4);
  });
  it('zero sqrt price -> 0', () => {
    expect(sqrtPriceX96ToPrice0in1(0n)).toBe(0);
  });
});

describe('v4 / v2 event decoders', () => {
  it('decodes a v4 Swap', () => {
    const { topics, data } = encodeLog(V4_SWAP, {
      id: POOL_ID,
      sender: SENDER,
      amount0: -5n,
      amount1: 7n,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 123n,
      tick: 0,
      fee: 3000,
    });
    const s = decodeV4Swap({ topics, data, blockNumber: '0x2a', transactionHash: '0xabc' });
    expect(s).not.toBeNull();
    expect(s!.sqrtPriceX96).toBe(2n ** 96n);
    expect(s!.liquidity).toBe(123n);
    expect(s!.block).toBe(42n);
    expect(s!.amount0).toBe(-5n);
  });

  it('decodes a v4 ModifyLiquidity delta (add and remove)', () => {
    for (const delta of [1000n, -2500n]) {
      const { topics, data } = encodeLog(V4_MODIFY_LIQUIDITY, {
        id: POOL_ID,
        sender: SENDER,
        tickLower: -60,
        tickUpper: 60,
        liquidityDelta: delta,
        salt: `0x${'00'.repeat(32)}` as Hex,
      });
      expect(decodeV4ModifyLiquidity({ topics, data, blockNumber: '0x1' })!.delta).toBe(delta);
    }
  });

  it('decodes a v2 Sync', () => {
    const { topics, data } = encodeLog(V2_SYNC, { reserve0: 111n, reserve1: 222n });
    const s = decodeV2Sync({ topics, data, blockNumber: '0x5' });
    expect(s!.reserve0).toBe(111n);
    expect(s!.reserve1).toBe(222n);
  });

  it('returns null on a non-matching topic0', () => {
    expect(decodeV4Swap({ topics: [`0x${'99'.repeat(32)}`], data: '0x' })).toBeNull();
  });
});
