/**
 * Design-partner API keys (spec §9): a plain `x-api-key` header that, once
 * x402 gating lands on a priced endpoint, bypasses it. Every priced endpoint
 * is free during the contest, so this currently only tags who called —
 * nothing is blocked on it yet.
 */
export interface CallerAuth {
  designPartner: boolean;
  /** the key that matched, for receipt logging — never the full list */
  keyPrefix: string | null;
}

export function checkDesignPartner(apiKey: string | undefined, knownKeys: string[]): CallerAuth {
  if (!apiKey || knownKeys.length === 0 || !knownKeys.includes(apiKey)) {
    return { designPartner: false, keyPrefix: null };
  }
  return { designPartner: true, keyPrefix: apiKey.slice(0, 6) };
}
