import { describe, expect, it, vi } from 'vitest';
import { firstTxBlock } from '../src/watcher/creator';

const CREATOR = '0x2222222222222222222222222222222222222222';

/** nonce is 0 below `firstBlock`, then 1+ from `firstBlock` on */
function nonceClient(firstBlock: bigint) {
  return {
    getTransactionCount: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) =>
      blockNumber >= firstBlock ? 5 : 0,
    ),
  };
}

describe('firstTxBlock (nonce binary search)', () => {
  it('converges to the exact block with enough iterations', async () => {
    const client = nonceClient(1_234_567n);
    const found = await firstTxBlock(client as never, CREATOR, 54_000_000n, 40);
    expect(found).toBe(1_234_567n);
  });

  it('with the default cap (8) brackets the block within sub-day precision', async () => {
    const client = nonceClient(1_234_567n);
    const found = await firstTxBlock(client as never, CREATOR, 54_000_000n);
    expect(found).toBeGreaterThanOrEqual(1_234_567n);
    expect(found! - 1_234_567n).toBeLessThan(54_000_000n / 256n); // ~211k blocks ≈ 6h
    expect(client.getTransactionCount.mock.calls.length).toBeLessThanOrEqual(9); // 1 + 8
  });

  it('handles a creator active from genesis', async () => {
    const client = nonceClient(0n);
    expect(await firstTxBlock(client as never, CREATOR, 100n)).toBe(0n);
  });

  it('returns null when the creator has no prior transactions (relayed launch)', async () => {
    const client = { getTransactionCount: vi.fn(async () => 0) };
    expect(await firstTxBlock(client as never, CREATOR, 54_000_000n)).toBeNull();
  });
});
