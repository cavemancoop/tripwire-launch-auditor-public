/**
 * Sorted-pair keccak256 Merkle proof verification (OpenZeppelin `MerkleProof`
 * convention) — the read half of `apps/worker/src/commit/merkle.ts`'s
 * `buildMerkleTree`. Duplicated rather than shared across a workspace package
 * boundary for these ~10 stable lines; keep the two in sync if the hashing
 * convention ever changes.
 */
import { concatHex, keccak256, type Hex } from 'viem';

function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(concatHex([a, b]))
    : keccak256(concatHex([b, a]));
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let computed = leaf.toLowerCase() as Hex;
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}
