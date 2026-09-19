import { buildLiquiditySeries } from './series';
import { notApplicable, resolved, unresolvable, type Resolution } from './types';
import type { ResolverContext } from './context';

const LIQ_FLOOR = 0.2; // liquidity <= 20% of post-launch peak

/**
 * LIQ_IMPAIRED (spec §1): primary-pool liquidity <= 20% of its post-launch peak
 * via removal transactions. v4 tracks cumulative ModifyLiquidity; v2 the
 * quote-side reserve from Sync. Raw-token depth only — no USD.
 */
export async function resolveLiqImpaired(ctx: ResolverContext): Promise<Resolution> {
  if (ctx.lpLockedByConstruction) return notApplicable('launchpad token: LP locked by construction');

  const series = await buildLiquiditySeries(
    ctx.client,
    ctx.pool,
    ctx.launchBlock,
    ctx.horizonBlock,
    ctx.maxRange,
  );
  const coverage = series.coverage;

  if (series.points.length === 0) {
    return unresolvable('no liquidity events observed for this pool', coverage);
  }

  const upToHorizon = series.points.filter((p) => p.block <= ctx.horizonBlock);
  if (upToHorizon.length === 0) {
    return unresolvable('no liquidity events at/before the horizon', coverage);
  }

  const peak = series.points.reduce((m, p) => (p.liquidity > m ? p.liquidity : m), 0);
  const current = upToHorizon[upToHorizon.length - 1]!.liquidity;
  if (peak <= 0) {
    return unresolvable('no positive liquidity observed', coverage);
  }

  const removals = series.points.filter((p) => p.delta < 0);
  const hasRemoval = removals.length > 0;
  const ratio = current / peak;
  // v2 has no explicit "removal" event — a reserve drop is the removal
  const impaired = ratio <= LIQ_FLOOR && (ctx.pool.poolKind === 'v2' || hasRemoval);

  return resolved(impaired, {
    method:
      ctx.pool.poolKind === 'v4'
        ? 'v4:ModifyLiquidity cumulative'
        : 'v2:Sync quote-side reserve',
    peakLiquidity: peak,
    currentLiquidity: current,
    ratio,
    removalCount: removals.length,
    removalTxs: removals.slice(0, 20).map((r) => r.txHash).filter(Boolean),
    points: series.points.length,
  }, coverage);
}
