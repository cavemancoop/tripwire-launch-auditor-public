/**
 * M5c — published per-token prices for the pinned deep-dive models, so a run's
 * cost can be *estimated* from its token counts when the gateway reports no
 * cost (the Orbio gateway returns OpenAI-shaped usage with no `cost` field and
 * 404s OpenRouter's `GET /generation`).
 *
 * An estimate is never presented as a measurement: the ledger row carries
 * `costBasis = 'token_estimate'` and this `PRICING_VERSION`, and the lifecycle
 * runner reconciles it against the provider's authoritative delta each epoch.
 * An unknown model yields `null`, never a guess (CLAUDE.md: no fabricated values).
 */

/** bump when any price below changes — stored on every estimated row */
export const PRICING_VERSION = 'openrouter-2026-09-11';

export interface ModelPrice {
  /** USD per 1M prompt tokens */
  inPerM: number;
  /** USD per 1M completion tokens */
  outPerM: number;
}

/** exact OpenRouter slugs only — never a `~` alias (a scored forecaster must be reproducible) */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'sakana/fugu-max': { inPerM: 2, outPerM: 6 },
  'deepseek/deepseek-v4.1-flash': { inPerM: 0.15, outPerM: 0.6 },
  'inception/mercury-2.5': { inPerM: 0.04, outPerM: 0.15 },
};

export function modelPrice(slug: string): ModelPrice | null {
  return MODEL_PRICES[slug] ?? null;
}

/**
 * tokens × price, rounded to micro-dollars. `null` when the model is unpriced or
 * either token count is missing — the caller records `unavailable`, not 0.
 */
export function estimateCostUsd(
  slug: string,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number | null {
  const p = modelPrice(slug);
  if (!p) return null;
  if (!isCount(promptTokens) || !isCount(completionTokens)) return null;
  const usd = (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;
