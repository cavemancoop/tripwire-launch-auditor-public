import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex, toHex, type Hex } from 'viem';

// Frozen-artifact hashes committed once on first run (spec §6). Guide M3:
// weights file, feature code, and outcome-rule text.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..'); // apps/worker/src/commit -> repo root

/** kind bytes32 = keccak256(label) */
export const ARTIFACT_KIND = {
  weights: keccak256(stringToHex('weights')),
  weightsV01: keccak256(stringToHex('weights_v0_1')),
  featureCode: keccak256(stringToHex('feature_code')),
  outcomeRule: keccak256(stringToHex('outcome_rule')),
  forecasterMappings: keccak256(stringToHex('forecaster_mappings')),
  scorerCode: keccak256(stringToHex('scorer_code')),
} as const;

/** files whose bytes define the scorer (spec §6: commit the scorer hash) */
const SCORER_CODE_FILES = [
  'packages/scoring/src/metrics.ts',
  'packages/scoring/src/delong.ts',
  'packages/scoring/src/scorer.ts',
  'packages/scoring/src/base-rate.ts',
  'packages/scoring/src/mappings.ts',
  'packages/scoring/src/types.ts',
];

/** files whose bytes define the deterministic feature vector (spec "feature code is public") */
const FEATURE_CODE_FILES = [
  'apps/worker/src/watcher/features.ts',
  'apps/worker/src/watcher/cluster.ts',
  'apps/worker/src/watcher/creator.ts',
  'apps/worker/src/watcher/holders.ts',
  'apps/worker/src/watcher/feature9.ts',
  'apps/worker/src/watcher/sellimpact.ts',
  'apps/worker/src/watcher/classify.ts',
  'apps/worker/src/watcher/freshness.ts',
  'apps/worker/src/watcher/hooks.ts',
  'apps/worker/src/watcher/primary-pool.ts',
  'apps/worker/src/watcher/erc20.ts',
  'packages/chain/src/v4-hooks.ts',
  'apps/worker/src/scanners/goplus.ts',
  'apps/worker/src/scanners/scanhood.ts',
  'packages/chain/src/uniswap.ts',
  'packages/scoring/src/inputs.ts',
  'packages/scoring/src/det.ts',
  'packages/scoring/src/heuristic.ts',
];

function hashFile(rel: string): Hex {
  return keccak256(toHex(readFileSync(join(repoRoot, rel))));
}

/** keccak256 of a sorted manifest "<sha> <path>\n" — order-stable, tamper-evident */
function hashFileSet(files: string[]): Hex {
  const manifest = [...files]
    .sort()
    .map((f) => `${hashFile(f)}  ${f}`)
    .join('\n');
  return keccak256(stringToHex(manifest));
}

export interface ArtifactHashes {
  weights: Hex;
  weightsV01: Hex;
  featureCode: Hex;
  outcomeRule: Hex;
  forecasterMappings: Hex;
  scorerCode: Hex;
}

export function computeArtifactHashes(): ArtifactHashes {
  return {
    weights: hashFile('packages/scoring/weights/det_v0.json'),
    weightsV01: hashFile('packages/scoring/weights/det_v0_1.json'),
    featureCode: hashFileSet(FEATURE_CODE_FILES),
    outcomeRule: hashFile('packages/scoring/OUTCOME_RULES_v1.md'),
    forecasterMappings: hashFile('packages/scoring/weights/forecaster_mappings_v0.json'),
    scorerCode: hashFileSet(SCORER_CODE_FILES),
  };
}

/** label -> ARTIFACT_KIND bytes32, for the re-commit job. */
export const ARTIFACT_KIND_BY_LABEL: Record<keyof ArtifactHashes, Hex> = {
  weights: ARTIFACT_KIND.weights,
  weightsV01: ARTIFACT_KIND.weightsV01,
  featureCode: ARTIFACT_KIND.featureCode,
  outcomeRule: ARTIFACT_KIND.outcomeRule,
  forecasterMappings: ARTIFACT_KIND.forecasterMappings,
  scorerCode: ARTIFACT_KIND.scorerCode,
};
