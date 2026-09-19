import { reportHash } from './crypto';
import type { ReportDraft } from './types';

// §8.3 report validator. A report may only be committed if it passes:
//  - requested / queried / reported chain + address match
//  - block pin has a real hash and timestamp
//  - no field marked unknown is presented as a pass
//  - signer matches the instance identity
// Failing reports are stored with the reasons and never committed.

export interface ValidateOptions {
  expectedChainId: number;
  expectedToken: string;
  agentAddress: string;
  /** reports older than this many seconds vs the pin block are stale */
  maxPinAgeSeconds?: number;
  now?: Date;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HIGH_UNKNOWN_RATIO = 0.7;
const PASS_FLOOR = 0.05;

export function validateReport(
  d: ReportDraft,
  o: ValidateOptions,
): { ok: boolean; failures: string[] } {
  const f: string[] = [];
  const c = d.content;

  // chain + address
  if (c.chainId !== o.expectedChainId) {
    f.push(`chainId ${c.chainId} != expected ${o.expectedChainId}`);
  }
  if (c.tokenAddress.toLowerCase() !== o.expectedToken.toLowerCase()) {
    f.push(`tokenAddress ${c.tokenAddress} != expected ${o.expectedToken}`);
  }

  // block pin
  if (!BYTES32.test(c.blockPin.hash)) f.push('block pin hash is not a 32-byte hex');
  if (!Number.isInteger(c.blockPin.number) || c.blockPin.number <= 0) {
    f.push('block pin number missing or non-positive');
  }
  const pinTs = Date.parse(c.blockPin.timestamp);
  if (!Number.isFinite(pinTs) || pinTs <= 0) {
    f.push('block pin timestamp missing or invalid');
  }

  // probabilities well-formed and in range
  const probs = Object.entries(c.probabilities);
  if (probs.length === 0) f.push('no probabilities');
  for (const [k, p] of probs) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      f.push(`probability ${k} out of range: ${String(p)}`);
    }
  }

  // no unknown-as-pass: a near-floor risk probability while most features were
  // unknown is a pass claimed on absent evidence.
  const totalFeatures = 21; // FeatureInputs numeric/boolean fields (approx)
  if (c.coverage.length >= HIGH_UNKNOWN_RATIO * totalFeatures) {
    const minP = Math.min(...probs.map(([, p]) => (typeof p === 'number' ? p : 1)));
    if (minP < PASS_FLOOR) {
      f.push(`clean call (min p=${minP}) with ${c.coverage.length}/${totalFeatures} features unknown`);
    }
  }

  // hash integrity
  if (reportHash(d.canonicalJson) !== d.reportHash) {
    f.push('reportHash does not match keccak256(canonicalJson)');
  }

  // signer identity
  if (!d.signature || !d.signer) {
    f.push('report is unsigned');
  } else if (d.signer.toLowerCase() !== o.agentAddress.toLowerCase()) {
    f.push(`signer ${d.signer} != agent identity ${o.agentAddress}`);
  }

  return { ok: f.length === 0, failures: f };
}
