import { newCoverage } from './coverage';
import { quoteExactInSingle, sellDirection } from './quote';
import { notApplicable, resolved, unresolvable, type Resolution } from './types';
import type { ResolverContext } from './context';

const TAX_FLOOR = 0.3; // effective sell tax >= 30% => impaired

/**
 * SELL_IMPAIRED (spec §1): at the horizon block, a fixed-size sell simulation
 * shows an effective sell tax >= 30%. Fixed size = 100 units of the paired
 * asset's worth of the token, priced off a tiny spot quote (checkpoint §8.4,
 * RPC-only).
 *
 * A **failed** quoter call — revert, archive miss, network error, or a
 * degenerate 0-output spot — is UNRESOLVABLE with the reason, never an outcome
 * (spec §8.3; checkpoint §C step 2). We cannot tell a genuine honeypot revert
 * from a bad poolKey / wrong-pool / archive quirk, and treating reverts as
 * `impaired=true` posted a spurious 100% rate into the benchmark. `true` is
 * only ever returned from the successful-quote tax comparison, or a bulk sell
 * that quotes to 0 *after* the spot quote succeeded (the pool demonstrably
 * quotes, and 100 units of sells drain it to nothing).
 */
export async function resolveSellImpaired(ctx: ResolverContext): Promise<Resolution> {
  if (ctx.lpLockedByConstruction) return notApplicable('launchpad token: LP locked by construction');
  const coverage = newCoverage(ctx.horizonBlock, ctx.horizonBlock, 0);

  if (!ctx.poolKey) {
    coverage.gaps.push('non-v4 pool; sell-impact quote not wired');
    return unresolvable('sell-impact quote only implemented for v4 pools', coverage);
  }

  const quoter = ctx.quoter as `0x${string}`;
  const { zeroForOne } = sellDirection(ctx.token, ctx.quote);
  const spotIn = 10n ** 12n;

  const spot = await quoteExactInSingle({
    client: ctx.client,
    quoter,
    poolKey: ctx.poolKey,
    zeroForOne,
    amountIn: spotIn,
    blockNumber: ctx.horizonBlock,
  });
  coverage.callCount += 1;
  if (!spot.ok) {
    return unresolvable(`spot sell quote ${spot.error} at horizon block`, coverage, {
      horizonBlock: Number(ctx.horizonBlock),
      rpcError: spot.message.split('\n')[0]!.slice(0, 200),
    });
  }
  if (spot.amountOut === 0n) {
    // a 1e-12 sell returning exactly 0 is a broken quote setup, not a signal
    return unresolvable('spot sell quote returns 0 (degenerate quote)', coverage, {
      horizonBlock: Number(ctx.horizonBlock),
    });
  }

  const notionalQuoteRaw = 100n * 10n ** BigInt(ctx.quoteDecimals);
  const sellSize = (notionalQuoteRaw * spotIn) / spot.amountOut; // token raw units ~= 100 quote units worth
  if (sellSize <= 0n) {
    coverage.notes.push('computed sell size rounded to 0; token likely very high unit price');
    return unresolvable('sell size underflow', coverage);
  }

  const bulk = await quoteExactInSingle({
    client: ctx.client,
    quoter,
    poolKey: ctx.poolKey,
    zeroForOne,
    amountIn: sellSize,
    blockNumber: ctx.horizonBlock,
  });
  coverage.callCount += 1;
  if (!bulk.ok) {
    return unresolvable(`100-unit sell quote ${bulk.error} at horizon block`, coverage, {
      sellSizeTokens: sellSize.toString(),
      rpcError: bulk.message.split('\n')[0]!.slice(0, 200),
    });
  }
  if (bulk.amountOut === 0n) {
    // spot quoted fine, so the pool works; 100 units of sells yielding 0 is real
    return resolved(true, { reason: '100-unit sell quote returns 0', sellSizeTokens: sellSize.toString() }, coverage);
  }

  const spotPer = Number(spot.amountOut) / Number(spotIn);
  const bulkPer = Number(bulk.amountOut) / Number(sellSize);
  const tax = Math.max(0, 1 - bulkPer / spotPer);

  return resolved(tax >= TAX_FLOOR, {
    notionalQuoteUnits: 100,
    quoteAsset: ctx.quote,
    quoteDecimals: ctx.quoteDecimals,
    sellSizeTokens: sellSize.toString(),
    spotPer,
    bulkPer,
    taxBps: Math.round(tax * 10_000),
    horizonBlock: Number(ctx.horizonBlock),
  }, coverage);
}
