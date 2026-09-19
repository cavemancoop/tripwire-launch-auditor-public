import { describe, expect, it } from 'vitest';
import { getChainConfig } from '../src/chain-config';
import { KNOWN_SOURCES, attributeSource } from '../src/launchpads';

const PONS_KEYS = ['pons', 'long', 'hookr', 'v4fun', 'noxa', 'sentry', 'virtuals', 'poolstrade'];

describe('launchpad registry (chain 4663)', () => {
  it('configures the eight requested launchpads in order', () => {
    expect(getChainConfig(4663).launchpads.map((l) => l.key)).toEqual(PONS_KEYS);
  });

  it('every configured key is a KNOWN_SOURCE, alongside raw + unknown', () => {
    for (const k of PONS_KEYS) expect(KNOWN_SOURCES).toContain(k);
    expect(KNOWN_SOURCES).toContain('raw');
    expect(KNOWN_SOURCES).toContain('unknown');
  });
});

describe('attributeSource', () => {
  it('matches a candidate Pons factory with low confidence', () => {
    const a = attributeSource(4663, ['0xE1aD3F2C507c2d4128c166d5Fa78Cc86CC94913c']);
    expect(a.source).toBe('pons');
    expect(a.viaCandidate).toBe(true);
    expect(a.sourceConfidence).toBeLessThan(0.8);
    // checkpoint 8.2: lpLockedByConstruction is only true after an on-chain
    // position-custody check — never from pad docs. None done yet.
    expect(a.lpLockedByConstruction).toBe(false);
  });

  it('matches the confirmed Pons factory with high confidence', () => {
    const a = attributeSource(4663, ['0x3711cea4feade896c913c68f01eda97cb06d1a42']);
    expect(a.source).toBe('pons');
    expect(a.viaCandidate).toBe(false);
    expect(a.sourceConfidence).toBeGreaterThan(0.9);
    expect(a.lpLockedByConstruction).toBe(false);
  });

  it('matches the confirmed LONG factory', () => {
    const a = attributeSource(4663, ['0x1b37d3a72082029c44b35b604ea473617580b69a']);
    expect(a.source).toBe('long');
    expect(a.viaCandidate).toBe(false);
    expect(a.sourceConfidence).toBeGreaterThan(0.9);
  });

  it('is case-insensitive on the touched address', () => {
    expect(attributeSource(4663, ['0xe1ad3f2c507c2d4128c166d5fa78cc86cc94913c']).source).toBe(
      'pons',
    );
  });

  it('returns "raw" when no launchpad address is touched', () => {
    const a = attributeSource(4663, [
      '0x1234567890123456789012345678901234567890',
      '0x0000000000000000000000000000000000000000',
    ]);
    expect(a.source).toBe('raw');
    expect(a.matchedAddress).toBeNull();
  });

  it('returns "raw" for an empty address set', () => {
    expect(attributeSource(4663, []).source).toBe('raw');
  });
});
