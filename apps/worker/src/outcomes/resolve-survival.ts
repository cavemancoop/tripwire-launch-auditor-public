import { buildPriceSeries } from './series';
import { resolved, unresolvable, type Resolution } from './types';
import type { ResolverContext } from './context';

/** ~6h of chain 4663 blocks (~0.1s/block) — the "still trading" check window */
const ALIVE_WINDOW_BLOCKS = 216_000n;

/**
 * TRADING_ALIVE (M4e): true when the primary pool had at least one trade in the
 * 6h ending at the horizon block. The research finding is that ~69% of launches
 * stop trading the day they launch; this is the outcome launchpads and
 * aggregators actually want to rank on. Positive polarity — the published
 * probability is P(still trading).
 */
export async function resolveSurvival(ctx: ResolverContext): Promise<Resolution> {
  const from = ctx.horizonBlock > ALIVE_WINDOW_BLOCKS ? ctx.horizonBlock - ALIVE_WINDOW_BLOCKS : 0n;

  let series;
  try {
    series = await buildPriceSeries(ctx.client, ctx.pool, from, ctx.horizonBlock, ctx.maxRange);
  } catch (err) {
    // an RPC failure must not be read as "dead" (checkpoint §C step 2)
    return unresolvable(
      `could not scan the survival window: ${err instanceof Error ? err.message.split('\n')[0] : err}`,
    );
  }

  if (series.points.length === 0 && series.coverage.gaps.length > 0) {
    const g = series.coverage.gaps.join('; ');
    if (/network|busy|timeout|log cap/i.test(g)) {
      return unresolvable(`could not scan the survival window: ${g}`, series.coverage);
    }
  }

  const alive = series.points.length > 0;
  const last = series.points[series.points.length - 1];
  return resolved(alive, {
    windowBlocks: [Number(from), Number(ctx.horizonBlock)],
    tradesInWindow: series.points.length,
    lastTradeBlock: last ? Number(last.block) : null,
    lastTradeTx: last?.txHash ?? null,
  }, series.coverage);
}
