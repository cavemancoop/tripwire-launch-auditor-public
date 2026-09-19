import { getChainConfig, type LaunchpadConfig } from './chain-config';

/** Known launchpad keys on Robinhood Chain, plus the two synthetic sources. */
export const KNOWN_SOURCES = [
  'pons',
  'long',
  'hookr',
  'v4fun',
  'noxa',
  'sentry',
  'virtuals',
  'poolstrade',
  'raw', // pool created directly on a DEX, no recognised launchpad
  'unknown', // not yet attributed
] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];

export interface LaunchAttribution {
  source: string;
  sourceConfidence: number; // 0..1
  lpLockedByConstruction: boolean;
  matchedAddress: string | null;
  viaCandidate: boolean; // matched an unconfirmed candidate factory
}

/** address (lowercased) -> { launchpad, isCandidate } */
export function buildLaunchpadIndex(
  chainId: number,
): Map<string, { lp: LaunchpadConfig; candidate: boolean }> {
  const idx = new Map<string, { lp: LaunchpadConfig; candidate: boolean }>();
  for (const lp of getChainConfig(chainId).launchpads) {
    for (const f of lp.factories) idx.set(f.toLowerCase(), { lp, candidate: false });
    for (const f of lp.candidateFactories ?? []) {
      if (!idx.has(f.toLowerCase())) idx.set(f.toLowerCase(), { lp, candidate: true });
    }
  }
  return idx;
}

/**
 * Attribute a launch to a launchpad from the addresses that appear in its launch
 * transaction (tx.to plus every log-emitting address). Confirmed factory match
 * wins over a candidate match; no match => "raw".
 */
export function attributeSource(
  chainId: number,
  touchedAddresses: Iterable<string>,
): LaunchAttribution {
  const idx = buildLaunchpadIndex(chainId);
  let candidateHit: LaunchAttribution | null = null;

  for (const raw of touchedAddresses) {
    const hit = idx.get(raw.toLowerCase());
    if (!hit) continue;
    if (!hit.candidate) {
      return {
        source: hit.lp.key,
        sourceConfidence: hit.lp.verified ? 0.95 : 0.8,
        lpLockedByConstruction: hit.lp.lpLockedByConstruction,
        matchedAddress: raw.toLowerCase(),
        viaCandidate: false,
      };
    }
    candidateHit ??= {
      source: hit.lp.key,
      sourceConfidence: 0.5,
      lpLockedByConstruction: hit.lp.lpLockedByConstruction,
      matchedAddress: raw.toLowerCase(),
      viaCandidate: true,
    };
  }

  return (
    candidateHit ?? {
      source: 'raw',
      sourceConfidence: 0.5,
      lpLockedByConstruction: false,
      matchedAddress: null,
      viaCandidate: false,
    }
  );
}
