import { keccak256, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildMerkleTree, verifyProof } from '../src/commit/merkle';

const leaf = (s: string): Hex => keccak256(stringToHex(s));
const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => leaf(`report-${i}`));

describe('buildMerkleTree', () => {
  it('rejects an empty leaf set', () => {
    expect(() => buildMerkleTree([])).toThrow();
  });

  it('a single leaf is its own root with an empty proof', () => {
    const t = buildMerkleTree([leaf('only')]);
    expect(t.root).toBe(leaf('only'));
    expect(t.leafCount).toBe(1);
    expect(verifyProof(leaf('only'), t.proofs.get(leaf('only'))!, t.root)).toBe(true);
  });

  it('every leaf proof verifies against the root (even and odd counts)', () => {
    for (const n of [2, 3, 4, 5, 8, 17]) {
      const ls = leaves(n);
      const t = buildMerkleTree(ls);
      expect(t.leafCount).toBe(n);
      for (const l of ls) {
        const p = t.proofs.get(l.toLowerCase())!;
        expect(verifyProof(l, p, t.root)).toBe(true);
      }
    }
  });

  it('is order-independent (sorted leaves) and deduplicates', () => {
    const a = buildMerkleTree([leaf('x'), leaf('y'), leaf('z')]);
    const b = buildMerkleTree([leaf('z'), leaf('x'), leaf('y'), leaf('x')]);
    expect(b.root).toBe(a.root);
    expect(b.leafCount).toBe(3);
  });

  it('rejects a tampered leaf', () => {
    const ls = leaves(6);
    const t = buildMerkleTree(ls);
    expect(verifyProof(leaf('not-in-tree'), t.proofs.get(ls[0]!.toLowerCase())!, t.root)).toBe(false);
  });
});
