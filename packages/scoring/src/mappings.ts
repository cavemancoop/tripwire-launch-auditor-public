import mapJson from '../weights/forecaster_mappings_v0.json';
import { ALL_OUTCOME_KEYS, outcomeIsPositive, type OutcomeKey } from './types';

/**
 * Fixed maps from ScanHood / GoPlus scan output to a probability per outcome
 * cell (spec §2 item 5). The constants live in
 * `weights/forecaster_mappings_v0.json`; its keccak256 is committed as an
 * artifact so the mapping is auditable and versioned.
 */
export const FORECASTER_MAPPINGS = mapJson as typeof mapJson;
export const FORECASTER_MAPPINGS_VERSION = mapJson.version;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const asBool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const emptyGrid = (): Partial<Record<OutcomeKey, number>> => ({});

/** ScanHood scan payload -> probabilities. Defensive about field names. */
export function scanhoodToProbabilities(
  scan: Record<string, unknown> | null | undefined,
): Partial<Record<OutcomeKey, number>> {
  if (!scan) return emptyGrid();
  const m = FORECASTER_MAPPINGS.scanhood;

  const verdictRaw = String(
    (scan['verdict'] ?? scan['risk'] ?? scan['rating'] ?? 'unknown') as string,
  )
    .toLowerCase()
    .replace(/\s+/g, '_');
  const verdictScore =
    (m.verdictScore as Record<string, number>)[verdictRaw] ?? m.verdictScore.unknown;

  const market = (scan['market'] ?? {}) as Record<string, unknown>;
  const sellable =
    scan['sellable'] ?? scan['can_sell'] ?? scan['canSell'] ?? market['sellable'] ?? true;
  const verified = scan['verified'] ?? scan['is_verified'] ?? true;
  const rwa = scan['rwa'] ?? scan['is_rwa'] ?? scan['impersonation'] ?? false;
  const lpLocked = scan['lp_locked'] ?? scan['lpLocked'] ?? scan['locked'];
  const deployer = (scan['deployer'] ?? {}) as Record<string, unknown>;
  const deployerLaunches = num(deployer['launches'] ?? deployer['count'] ?? deployer['deploys']);

  let raw = verdictScore;
  if (!asBool(sellable) && sellable !== undefined) raw += m.bump.notSellable;
  if (!asBool(verified) && verified !== undefined) raw += m.bump.notVerified;
  if (asBool(rwa)) raw += m.bump.rwaImpersonation;
  if (lpLocked !== undefined && !asBool(lpLocked)) raw += m.bump.lpUnlocked;
  if (deployerLaunches === 0) raw += m.bump.freshDeployer;
  raw = clamp01(raw);

  const out = emptyGrid();
  for (const key of ALL_OUTCOME_KEYS) {
    const factor = (m.outcomeFactor as Record<string, number>)[key];
    if (factor === undefined) continue;
    let p = raw * factor;
    if (key.startsWith('SELL_IMPAIRED') && !asBool(sellable) && sellable !== undefined) {
      p = Math.max(p, 0.85); // sellability is the direct SELL_IMPAIRED signal
    }
    p = Math.min(m.cap, clamp01(p));
    out[key] = round4(outcomeIsPositive(key) ? 1 - p : p); // TRADING_ALIVE is inverted
  }
  return out;
}

const GOPLUS_FLAG_KEYS = Object.keys(FORECASTER_MAPPINGS.goplus.flagWeight);

/** GoPlus token_security payload -> probabilities. */
export function goplusToProbabilities(
  gp: Record<string, unknown> | null | undefined,
): Partial<Record<OutcomeKey, number>> {
  if (!gp) return emptyGrid();
  const m = FORECASTER_MAPPINGS.goplus;

  let raw = m.base;
  for (const flag of GOPLUS_FLAG_KEYS) {
    if (asBool(gp[flag])) raw += (m.flagWeight as Record<string, number>)[flag] ?? 0;
  }
  const sellTaxPct = num(gp['sell_tax']) * (num(gp['sell_tax']) <= 1 ? 100 : 1);
  raw += Math.min(m.sellTax.cap, sellTaxPct * m.sellTax.perPercent);
  raw = clamp01(raw);

  const out = emptyGrid();
  for (const key of ALL_OUTCOME_KEYS) {
    const factor = (m.outcomeFactor as Record<string, number>)[key];
    if (factor === undefined) continue;
    const p = Math.min(m.cap, clamp01(raw * factor));
    out[key] = round4(outcomeIsPositive(key) ? 1 - p : p);
  }
  return out;
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
