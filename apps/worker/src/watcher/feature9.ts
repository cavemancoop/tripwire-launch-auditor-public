import type { Hex, PublicClient } from 'viem';
import { fetchGoPlus, mapGoPlus, type GoPlusOptions } from '../scanners/goplus';
import { fetchScanHoodScan, mapScanHood, type ScanHoodOptions } from '../scanners/scanhood';
import { quoteSellImpact } from './sellimpact';

// Feature 9 (spec §3.3.9, non-launchpad only): verified, owner_renounced,
// mintable, lp_holder_type, sell_sim_ok, sell_tax_bps — from a GoPlus/ScanHood
// cross-check plus our own quote-based sell impact. Also fills feature 7's
// liquidity_usd_10m (from ScanHood's market data) and sell_impact_bps (our quote).
// Do not rebuild honeypot detection; consume it.

export interface Feature9Fields {
  verified: boolean | null;
  ownerRenounced: boolean | null;
  mintable: boolean | null;
  lpHolderType: string | null;
  sellSimOk: boolean | null;
  sellTaxBps: number | null;
  /** = sellImpactBps1000 ("holder-sized"); kept for the det_v0 weights */
  sellImpactBps: number | null;
  sellImpactBps100: number | null;
  sellImpactBps1000: number | null;
  liquidityUsd10m: number | null;
}

export interface Feature9Result extends Feature9Fields {
  goplusRaw: unknown;
  goplusFetchedAt: Date | null;
  scanhoodRaw: unknown;
  scanhoodFetchedAt: Date | null;
  /** per-field cross-check: what each source said + whether they agree */
  crossCheck: Record<string, { goplus: unknown; scanhood: unknown; agree: boolean | null }>;
}

export interface Feature9Params {
  client: Pick<PublicClient, 'request'>;
  token: Hex;
  quote: Hex | null;
  quoter: Hex;
  poolFee: number | null;
  poolTickSpacing: number | null;
  poolHooks: string | null;
  /** decimals of the quote asset, for the 100 / 1,000 quote-unit sell notionals */
  quoteDecimals: number;
  blockNumber?: bigint;
  goplus?: GoPlusOptions;
  scanhood?: ScanHoodOptions;
}

function agreement(a: unknown, b: unknown): boolean | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return a === b;
}

/** first non-null of the arguments */
function coalesce<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v !== null && v !== undefined) return v as T;
  return null;
}

export async function computeFeature9(p: Feature9Params): Promise<Feature9Result> {
  const [goplus, scanhood] = await Promise.all([
    fetchGoPlus(p.token, p.goplus),
    fetchScanHoodScan(p.token, p.scanhood),
  ]);

  const gp = mapGoPlus(goplus.security);
  const sh = mapScanHood(scanhood.data);

  let sellImpactBps100: number | null = null;
  let sellImpactBps1000: number | null = null;
  let ownQuoteSellOk: boolean | null = null;
  if (
    p.quote &&
    p.quote !== '0x0000000000000000000000000000000000000000' &&
    p.poolFee !== null &&
    p.poolTickSpacing !== null
  ) {
    const dec = BigInt(p.quoteDecimals);
    const q = await quoteSellImpact({
      client: p.client,
      quoter: p.quoter,
      token: p.token,
      quote: p.quote,
      fee: p.poolFee,
      tickSpacing: p.poolTickSpacing,
      hooks: (p.poolHooks ?? '0x0000000000000000000000000000000000000000') as Hex,
      notionalsQuote: [100n * 10n ** dec, 1000n * 10n ** dec],
      blockNumber: p.blockNumber,
    });
    sellImpactBps100 = q.results[0]?.impactBps ?? null;
    sellImpactBps1000 = q.results[1]?.impactBps ?? null;
    ownQuoteSellOk = q.spotOk === false ? false : q.results.some((r) => r.simOk) ? true : q.spotOk;
  }
  const sellImpactBps = sellImpactBps1000; // "holder-sized" — kept for det_v0

  // sell_sim_ok: any of our quote / GoPlus (not honeypot) / ScanHood (sellable)
  const sellSimOk = coalesce<boolean>(
    ownQuoteSellOk,
    gp.honeypot === null ? null : !gp.honeypot,
    sh.sellable,
  );

  const fields: Feature9Fields = {
    verified: coalesce(gp.verified, sh.verified),
    ownerRenounced: gp.ownerRenounced,
    mintable: gp.mintable,
    lpHolderType: coalesce(
      sh.lpHolderType,
      gp.lpLocked === null ? null : gp.lpLocked ? 'locked' : 'unlocked',
    ),
    sellSimOk,
    sellTaxBps: gp.sellTaxBps,
    sellImpactBps,
    sellImpactBps100,
    sellImpactBps1000,
    liquidityUsd10m: sh.liquidityUsd,
  };

  const crossCheck: Feature9Result['crossCheck'] = {
    verified: { goplus: gp.verified, scanhood: sh.verified, agree: agreement(gp.verified, sh.verified) },
    sellSimOk: {
      goplus: gp.honeypot === null ? null : !gp.honeypot,
      scanhood: sh.sellable,
      agree: agreement(gp.honeypot === null ? null : !gp.honeypot, sh.sellable),
    },
  };

  return {
    ...fields,
    goplusRaw: goplus.raw,
    goplusFetchedAt: goplus.fetchedAt,
    scanhoodRaw: scanhood.raw,
    scanhoodFetchedAt: scanhood.fetchedAt,
    crossCheck,
  };
}
