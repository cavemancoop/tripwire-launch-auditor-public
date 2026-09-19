import { concatHex, keccak256, type Hex } from 'viem';

// Binary Merkle tree over report hashes with sorted-pair keccak256 hashing
// (OpenZeppelin `MerkleProof` convention). An odd node at a level is promoted
// unchanged. Leaves are the report hashes as-is (already keccak256 digests).

function hashPair(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase()
    ? keccak256(concatHex([a, b]))
    : keccak256(concatHex([b, a]));
}

export interface MerkleTree {
  root: Hex;
  leafCount: number;
  /** leaves, lowercased and sorted (index order used in stored proofs) */
  leaves: Hex[];
  /** leaf hash -> ordered sibling hashes from leaf to root */
  proofs: Map<string, Hex[]>;
}

export function buildMerkleTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error('buildMerkleTree: no leaves');
  const ordered = [...new Set(leaves.map((l) => l.toLowerCase() as Hex))].sort();
  const proofs = new Map<string, Hex[]>();
  for (const l of ordered) proofs.set(l, []);

  // track which original leaves flow through each node position
  let level: Hex[] = ordered;
  let groups: string[][] = ordered.map((l) => [l]);

  while (level.length > 1) {
    const nextLevel: Hex[] = [];
    const nextGroups: string[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const leftGroup = groups[i]!;
      if (i + 1 < level.length) {
        const right = level[i + 1]!;
        const rightGroup = groups[i + 1]!;
        for (const leaf of leftGroup) proofs.get(leaf)!.push(right);
        for (const leaf of rightGroup) proofs.get(leaf)!.push(left);
        nextLevel.push(hashPair(left, right));
        nextGroups.push([...leftGroup, ...rightGroup]);
      } else {
        nextLevel.push(left); // promote odd node unchanged
        nextGroups.push(leftGroup);
      }
    }
    level = nextLevel;
    groups = nextGroups;
  }

  return { root: level[0]!, leafCount: ordered.length, leaves: ordered, proofs };
}

/** Verify a leaf against a root using its proof (must match buildMerkleTree). */
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let computed = leaf.toLowerCase() as Hex;
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === root.toLowerCase();
}
