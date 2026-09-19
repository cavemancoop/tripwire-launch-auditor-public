import { mergeCoverage } from './coverage';
import { quoteExactInSingle, sellDirection } from './quote';
import { buildPriceSeries } from './series';
import { resolved, unresolvable, type Resolution } from './types';
import type { ResolverContext } from './context';

const DRAWDOWN_FLOOR = 0.2; // price <= 20% of reference max
/** how far back from the horizon to look for "the price at the horizon" before
 *  falling back to a Quoter spot call — keeps the scan bounded for 7d horizons */
const HORIZON_TAIL_BLOCKS = 50_000n;

/**
 * DRAWDOWN_80 (spec §1): price at the horizon <= 20% of the max price in the
 * reference window. Reference = the first 24h after the anchor for launch-time
 * reports, and the 24h before the anchor otherwise (§1.1). Horizon price = last
 * swap after the reference window and before the horizon block; if the token
 * went silent, a Quoter spot call at the horizon block. Decimals cancel: series
 * and quoter are both raw-quote-per-raw-token.
 */
export async function resolveDrawdown(ctx: ResolverContext): Promise<Resolution> {
  const ref = await buildPriceSeries(
    ctx.client,
    ctx.pool,
    ctx.drawdownRefStart,
    ctx.drawdownRefEnd,
    ctx.maxRange,
  );
  let coverage = ref.coverage;

  const refMax = ref.points.reduce((m, p) => (p.price > m ? p.price : m), 0);
  if (refMax <= 0) {
    return unresolvable('no positive price in the reference window', coverage, {
      refWindowBlocks: [Number(ctx.drawdownRefStart), Number(ctx.drawdownRefEnd)],
    });
  }

  let horizonPrice: number | null = null;
  let horizonSource: 'swap' | 'quote' = 'swap';
  let lastSwapTx: string | null = null;

  const tailStart = ctx.horizonBlock > HORIZON_TAIL_BLOCKS ? ctx.horizonBlock - HORIZON_TAIL_BLOCKS : 0n;
  const postStart = ctx.drawdownRefEnd + 1n > tailStart ? ctx.drawdownRefEnd + 1n : tailStart;
  if (postStart <= ctx.horizonBlock) {
    if (postStart > ctx.drawdownRefEnd + 1n) {
      coverage.notes.push(
        `horizon-price scan capped to the last ${HORIZON_TAIL_BLOCKS} blocks; earlier trades fall back to the quoter spot`,
      );
    }
    const post = await buildPriceSeries(ctx.client, ctx.pool, postStart, ctx.horizonBlock, ctx.maxRange);
    coverage = mergeCoverage(coverage, post.coverage);
    const last = post.points[post.points.length - 1];
    if (last) {
      horizonPrice = last.price;
      lastSwapTx = last.txHash;
    }
  } else {
    // 24h horizon: the horizon block is ~the reference-window end
    const last = ref.points[ref.points.length - 1];
    if (last) {
      horizonPrice = last.price;
      lastSwapTx = last.txHash;
    }
  }

  if (horizonPrice === null) {
    if (!ctx.poolKey) {
      return unresolvable('no swap after the reference window and no v4 quoter available', coverage, {
        refMaxPrice: refMax,
      });
    }
    const amountIn = 10n ** 15n;
    const q = await quoteExactInSingle({
      client: ctx.client,
      quoter: ctx.quoter as `0x${string}`,
      poolKey: ctx.poolKey,
      zeroForOne: sellDirection(ctx.token, ctx.quote).zeroForOne,
      amountIn,
      blockNumber: ctx.horizonBlock,
    });
    coverage.callCount += 1;
    if (!q.ok) {
      if (q.error === 'revert') {
        horizonPrice = 0; // cannot sell -> price is effectively 0
        horizonSource = 'quote';
      } else {
        return unresolvable(`quoter ${q.error} at horizon block`, coverage, {
          refMaxPrice: refMax,
          rpcError: q.message.split('\n')[0]!.slice(0, 200),
        });
      }
    } else {
      horizonPrice = Number(q.amountOut) / Number(amountIn);
      horizonSource = 'quote';
    }
  }

  const ratio = horizonPrice / refMax;
  return resolved(ratio <= DRAWDOWN_FLOOR, {
    refMaxPrice: refMax,
    refWindowBlocks: [Number(ctx.drawdownRefStart), Number(ctx.drawdownRefEnd)],
    horizonBlock: Number(ctx.horizonBlock),
    horizonPrice,
    horizonSource,
    ratio,
    refSwapPoints: ref.points.length,
    lastSwapTx,
  }, coverage);
}
