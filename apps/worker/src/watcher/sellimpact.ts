import {
  decodeFunctionResult,
  encodeFunctionData,
  numberToHex,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';

// Our own quote-based sell impact (spec §3.3.7). M4d / checkpoint §8.4: size the
// sell to fixed *quote-asset notionals* (100 and 1,000 units, i.e. 100 / 1,000
// USDG for USDG pools) off a tiny spot quote — comparable across tokens and
// closer to what a real seller faces than "0.1% of supply". RPC-only, no fork.
// v4 only for now (v3 is barely used on 4663).

const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

const ZERO = '0x0000000000000000000000000000000000000000';
const SPOT_IN = 10n ** 12n; // tiny token amount for the near-spot reference quote

export interface SellImpactParams {
  client: Pick<PublicClient, 'request'>;
  quoter: Hex;
  token: Hex;
  quote: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
  /** raw quote-unit notionals to size the sell to */
  notionalsQuote: bigint[];
  blockNumber?: bigint;
}

export interface SizedSellImpact {
  notionalQuote: bigint;
  sellSizeTokens: bigint;
  impactBps: number | null;
  simOk: boolean | null;
}

export interface SellImpactResult {
  /** did the near-spot reference quote succeed */
  spotOk: boolean | null;
  results: SizedSellImpact[];
}

export async function quoteSellImpact(p: SellImpactParams): Promise<SellImpactResult> {
  const t = p.token.toLowerCase();
  const q = p.quote.toLowerCase();
  const c0 = (t < q ? t : q) as Hex;
  const c1 = (t < q ? q : t) as Hex;
  const zeroForOne = t === c0; // selling the token: token -> quote
  const poolKey = { currency0: c0, currency1: c1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: (p.hooks || ZERO) as Hex };
  const blockTag = p.blockNumber !== undefined ? numberToHex(p.blockNumber) : 'latest';

  const call = async (exactAmount: bigint): Promise<bigint | null> => {
    if (exactAmount <= 0n) return null;
    try {
      const res = (await p.client.request({
        method: 'eth_call',
        params: [
          {
            to: p.quoter,
            data: encodeFunctionData({
              abi: QUOTER_ABI,
              functionName: 'quoteExactInputSingle',
              args: [{ poolKey, zeroForOne, exactAmount, hookData: '0x' }],
            }),
          },
          blockTag,
        ],
      })) as Hex;
      const [out] = decodeFunctionResult({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        data: res,
      }) as readonly [bigint, bigint];
      return out;
    } catch {
      return null;
    }
  };

  const spotOut = await call(SPOT_IN);
  if (spotOut === null || spotOut === 0n) {
    return {
      spotOk: false,
      results: p.notionalsQuote.map((n) => ({
        notionalQuote: n,
        sellSizeTokens: 0n,
        impactBps: null,
        simOk: false,
      })),
    };
  }
  const spotPer = Number(spotOut) / Number(SPOT_IN);

  const results: SizedSellImpact[] = [];
  for (const notionalQuote of p.notionalsQuote) {
    const sellSize = (notionalQuote * SPOT_IN) / spotOut; // token raw ~= `notionalQuote` quote units
    const bulkOut = await call(sellSize);
    if (bulkOut === null || bulkOut === 0n) {
      results.push({ notionalQuote, sellSizeTokens: sellSize, impactBps: null, simOk: false });
      continue;
    }
    const bulkPer = Number(bulkOut) / Number(sellSize);
    const impact = Math.round((1 - bulkPer / spotPer) * 10_000);
    results.push({
      notionalQuote,
      sellSizeTokens: sellSize,
      impactBps: Math.max(0, impact),
      simOk: true,
    });
  }
  return { spotOk: true, results };
}
