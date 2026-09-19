import {
  decodeFunctionResult,
  encodeFunctionData,
  numberToHex,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';

/**
 * v4 Quoter `quoteExactInputSingle` via eth_call, with the failure taxonomy M4
 * needs: a plain revert is a real signal (the pool won't let you sell), a
 * missing-archive-state / network error is NOT — it means "unresolvable", never
 * "impaired".
 */
const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export interface PoolKey {
  currency0: Hex;
  currency1: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
}

export type QuoteError = 'revert' | 'archive' | 'network';

export type QuoteOutcome =
  | { ok: true; amountOut: bigint }
  | { ok: false; error: QuoteError; message: string };

const ARCHIVE_RE =
  /missing trie node|header not found|missing.*(state|archive)|no historical|not available|state.*not.*available|pruned|block .* not found|could not be found|getDeleteStateObject|required historical state/i;
const REVERT_RE = /revert|execution reverted|VM Exception|invalid opcode|out of gas|0x[0-9a-f]*$/i;

export function classifyQuoteError(err: unknown): QuoteError {
  const msg = err instanceof Error ? err.message : String(err);
  if (ARCHIVE_RE.test(msg)) return 'archive';
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network|fetch failed|429/i.test(msg)) {
    return 'network';
  }
  if (REVERT_RE.test(msg)) return 'revert';
  return 'network';
}

export async function quoteExactInSingle(args: {
  client: Pick<PublicClient, 'request'>;
  quoter: Hex;
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  blockNumber?: bigint;
}): Promise<QuoteOutcome> {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: args.poolKey, zeroForOne: args.zeroForOne, exactAmount: args.amountIn, hookData: '0x' }],
  });
  const blockTag = args.blockNumber !== undefined ? numberToHex(args.blockNumber) : 'latest';
  try {
    const res = (await args.client.request({
      method: 'eth_call',
      params: [{ to: args.quoter, data }, blockTag],
    })) as Hex;
    const [amountOut] = decodeFunctionResult({
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      data: res,
    }) as readonly [bigint, bigint];
    return { ok: true, amountOut };
  } catch (err) {
    return {
      ok: false,
      error: classifyQuoteError(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** currency0/currency1 ordering + zeroForOne for selling `token` into `quote`. */
export function sellDirection(token: string, quote: string): { zeroForOne: boolean } {
  return { zeroForOne: token.toLowerCase() < quote.toLowerCase() };
}
