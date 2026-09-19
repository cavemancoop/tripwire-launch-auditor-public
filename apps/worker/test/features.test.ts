import { describe, expect, it, vi } from 'vitest';
import { computeIndexFeatures, computeT10Features } from '../src/watcher/features';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const pad = (a: string): string => `0x${'0'.repeat(24)}${a.slice(2)}`;
const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;

const RECIPIENT = '0x9999999999999999999999999999999999999999';

describe('computeIndexFeatures — creator_devbuy_pct (spec §3.3 item 2, §8.2)', () => {
  it('measures the largest non-pool recipient of the token in the launch tx', async () => {
    const client = {
      getTransactionReceipt: vi.fn(async () => ({
        logs: [
          // curve/pool -> a buy recipient that is NOT tx.from (Pons-style router send)
          { address: TOKEN, topics: [TRANSFER, pad(POOL), pad(RECIPIENT)], data: word(10n ** 18n) },
          // pool -> pool and a non-Transfer log: both ignored
          { address: TOKEN, topics: [TRANSFER, pad(POOL), pad(POOL)], data: word(5n * 10n ** 17n) },
          { address: POOL, topics: ['0xdeadbeef'], data: '0x' },
        ],
      })),
      readContract: vi.fn(async () => 4n * 10n ** 18n), // 25% of supply
    };

    const f = await computeIndexFeatures(client as never, TOKEN, '0xabc', POOL);
    expect(f.creatorDevbuyPct).toBeCloseTo(25);
    expect(f.devbuyRecipient).toBe(RECIPIENT.toLowerCase());
    expect(f.hasX).toBeNull();
  });

  it('returns null when the RPC calls throw', async () => {
    const client = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      readContract: vi.fn(),
    };
    const f = await computeIndexFeatures(client as never, TOKEN, '0xabc', POOL);
    expect(f.creatorDevbuyPct).toBeNull();
    expect(f.devbuyRecipient).toBeNull();
  });
});

describe('computeT10Features — buyers in the first 10 minutes (spec §3.3 item 6)', () => {
  it('counts distinct recipients of tokens leaving the pool', async () => {
    const buyerA = '0x4444444444444444444444444444444444444444';
    const buyerB = '0x5555555555555555555555555555555555555555';
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_getLogs') throw new Error(method);
      return [
        { topics: [TRANSFER, pad(POOL), pad(buyerA)], data: word(1n) },
        { topics: [TRANSFER, pad(POOL), pad(buyerA)], data: word(1n) },
        { topics: [TRANSFER, pad(POOL), pad(buyerB)], data: word(1n) },
      ];
    });

    const f = await computeT10Features({ request } as never, {
      token: TOKEN,
      liquiditySource: POOL,
      fromBlock: 10n,
      toBlock: 20n,
      maxRange: 2000,
    });
    expect(f.uniqueBuyers10m).toBe(2);
    expect(f.buysPerBuyer10m).toBeCloseTo(1.5);
  });
});
