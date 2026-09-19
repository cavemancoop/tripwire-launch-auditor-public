import { describe, expect, it, vi } from 'vitest';
import { computeHolderStats, reconstructBalances } from '../src/watcher/holders';
import { TRANSFER_TOPIC0, addressToTopic } from '../src/watcher/erc20';

const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const A = '0x4444444444444444444444444444444444444444';
const B = '0x5555555555555555555555555555555555555555';
const C = '0x6666666666666666666666666666666666666666';
const ZERO = '0x0000000000000000000000000000000000000000';

const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const T = (from: string, to: string, v: bigint) => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC0, addressToTopic(from), addressToTopic(to)],
  data: word(v),
});

// mint 1000 to pool, pool sells 100 to A, 200 to B, 50 to C; A sends 40 to B
const LOGS = [
  T(ZERO, POOL, 1000n),
  T(POOL, A, 100n),
  T(POOL, B, 200n),
  T(POOL, C, 50n),
  T(A, B, 40n),
];

function logClient() {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_getLogs') throw new Error(method);
      return LOGS;
    }),
  };
}

describe('reconstructBalances', () => {
  it('nets Transfer logs into balances and skips the zero address', async () => {
    const bal = await reconstructBalances(logClient() as never, TOKEN, 0n, 100n, 2000);
    expect(bal).not.toBeNull();
    expect(bal!.get(POOL)).toBe(1000n - 100n - 200n - 50n); // 650
    expect(bal!.get(A)).toBe(100n - 40n); // 60
    expect(bal!.get(B)).toBe(200n + 40n); // 240
    expect(bal!.get(C)).toBe(50n);
    expect(bal!.has(ZERO)).toBe(false);
  });
});

describe('computeHolderStats', () => {
  it('computes cluster and top-10 non-creator supply share, excluding creator + pool', async () => {
    const stats = await computeHolderStats({
      logClient: logClient() as never,
      readClient: { readContract: vi.fn(async () => 1000n) } as never,
      token: TOKEN,
      fromBlock: 0n,
      toBlock: 100n,
      maxRange: 2000,
      creator: CREATOR,
      cluster: new Set([CREATOR, A]), // A is a cluster member holding 60
      liquiditySource: POOL,
    });
    // cluster balance = creator(0) + A(60) => 6%
    expect(stats.clusterSupplyPct).toBeCloseTo(6);
    // non-creator, non-pool holders: B(240), A(60), C(50) => 350 / 1000 = 35%
    expect(stats.top10NoncreatorPct).toBeCloseTo(35);
    expect(stats.holderCount).toBe(3);
  });
});
