import { keccak256, size, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_KIND, computeArtifactHashes } from '../src/commit/artifacts';

describe('artifact hashes', () => {
  it('kinds are keccak256 of their labels', () => {
    expect(ARTIFACT_KIND.weights).toBe(keccak256(stringToHex('weights')));
    expect(ARTIFACT_KIND.featureCode).toBe(keccak256(stringToHex('feature_code')));
    expect(ARTIFACT_KIND.outcomeRule).toBe(keccak256(stringToHex('outcome_rule')));
    expect(ARTIFACT_KIND.forecasterMappings).toBe(keccak256(stringToHex('forecaster_mappings')));
    expect(ARTIFACT_KIND.scorerCode).toBe(keccak256(stringToHex('scorer_code')));
    expect(ARTIFACT_KIND.weightsV01).toBe(keccak256(stringToHex('weights_v0_1')));
  });

  it('computes six distinct 32-byte hashes, deterministically', () => {
    const a = computeArtifactHashes();
    const b = computeArtifactHashes();
    const all = [a.weights, a.weightsV01, a.featureCode, a.outcomeRule, a.forecasterMappings, a.scorerCode];
    for (const h of all) expect(size(h)).toBe(32);
    expect(new Set(all).size).toBe(6);
    expect(a).toEqual(b);
  });
});
