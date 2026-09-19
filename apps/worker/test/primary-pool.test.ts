import { describe, expect, it, vi } from 'vitest';
import { annotate, isFeeSuspect, pickPrimaryV4Pool, rankCandidates } from '../src/watcher/primary-pool';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NATIVE = '0x0000000000000000000000000000000000000000';
const TOKEN = '0x1111111111111111111111111111111111111111';
const RANDOM = '0x9999999999999999999999999999999999999999';

const raw = (o: Partial<Parameters<typeof annotate>[0]>) =>
  annotate(
    {
      poolId: o.poolId ?? `0x${'0'.repeat(64)}`,
      currency0: o.currency0 ?? TOKEN,
      currency1: o.currency1 ?? USDG,
      fee: o.fee ?? 3000,
      tickSpacing: o.tickSpacing ?? 60,
      hooks: o.hooks ?? null,
      initBlock: o.initBlock ?? 100n,
    },
    4663,
  );

describe('isFeeSuspect', () => {
  it('flags >= 10% (100_000)', () => {
    expect(isFeeSuspect(3000)).toBe(false);
    expect(isFeeSuspect(10000)).toBe(false);
    expect(isFeeSuspect(100000)).toBe(true);
    expect(isFeeSuspect(430000)).toBe(true); // the NVDA decoy pool
    expect(isFeeSuspect(null)).toBe(false);
  });
});

describe('annotate', () => {
  it('identifies a known quote on either side', () => {
    expect(raw({ currency0: TOKEN, currency1: USDG }).quote).toBe(USDG);
    expect(raw({ currency0: NATIVE, currency1: TOKEN }).quote).toBe(NATIVE);
    expect(raw({ currency0: TOKEN, currency1: RANDOM }).quoteIsKnown).toBe(false);
  });
});

describe('rankCandidates', () => {
  it('prefers known-quote, non-suspect fee, standard tier, then earliest', () => {
    const junk = raw({ poolId: '0xjunk', currency1: RANDOM, fee: 430000, initBlock: 90n });
    const real = raw({ poolId: '0xreal', currency1: USDG, fee: 3000, initBlock: 120n });
    expect(rankCandidates([junk, real])[0]!.poolId).toBe('0xreal');
  });

  it('breaks a known-quote tie by activity then block', () => {
    const a = { ...raw({ poolId: '0xa', initBlock: 100n }), activity: 5 };
    const b = { ...raw({ poolId: '0xb', initBlock: 101n }), activity: 50 };
    expect(rankCandidates([a, b])[0]!.poolId).toBe('0xb');
  });
});

describe('pickPrimaryV4Pool', () => {
  const initTopic = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
  // Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)
  const initLog = (id: string, c0: string, c1: string, fee: number) => ({
    address: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    topics: [initTopic, id, `0x${'0'.repeat(24)}${c0.slice(2)}`, `0x${'0'.repeat(24)}${c1.slice(2)}`],
    data:
      '0x' +
      fee.toString(16).padStart(64, '0') +
      (60).toString(16).padStart(64, '0') +
      '0'.repeat(64) + // hooks
      '0'.repeat(64) + // sqrtPriceX96
      '0'.repeat(64), // tick
    blockNumber: '0x64',
    logIndex: '0x0',
    transactionHash: '0xabc',
  });

  it('switches off a suspect side pool onto the USDG pool', async () => {
    const client = {
      request: vi.fn(async ({ params }: { method: string; params: any[] }) => {
        const p = params[0];
        // currency0 == token query (topics length 3) vs currency1 == token (length 4)
        if (p.topics.length >= 4) return [];
        return [
          initLog(`0x${'a'.repeat(64)}`, TOKEN, RANDOM, 430000), // suspect decoy
          initLog(`0x${'b'.repeat(64)}`, TOKEN, USDG, 3000), // real
        ];
      }),
    };
    const pick = await pickPrimaryV4Pool(client as never, {
      chainId: 4663,
      token: TOKEN,
      currentPoolId: `0x${'a'.repeat(64)}`,
      scanFrom: 0n,
      scanTo: 1000n,
      activityFrom: 0n,
      activityTo: 100n,
      maxRange: 9999,
    });
    expect(pick.changed).toBe(true);
    expect(pick.chosen?.poolId).toBe(`0x${'b'.repeat(64)}`);
    expect(pick.chosen?.quote).toBe(USDG);
  });

  // The scan window runs *forward* from the launch block (+2h of 0.1s blocks =
  // 72k), so on a fresh launch most of it is in the future. Chainstack rejects
  // a window that starts past the head with "invalid block range params",
  // which aborted the whole check and left launches on the decoy pool.
  it('never asks for blocks past the chain head', async () => {
    const asked: Array<{ from: bigint; to: bigint }> = [];
    const client = {
      request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
        if (method === 'eth_blockNumber') return '0x2710'; // head = 10_000
        const p = params[0];
        asked.push({ from: BigInt(p.fromBlock), to: BigInt(p.toBlock) });
        return p.topics.length >= 4 ? [] : [initLog(`0x${'b'.repeat(64)}`, TOKEN, USDG, 3000)];
      }),
    };

    await pickPrimaryV4Pool(client as never, {
      chainId: 4663,
      token: TOKEN,
      currentPoolId: null,
      scanFrom: 9_000n,
      scanTo: 9_000n + 72_000n, // 2h forward — way past head
      activityFrom: 9_000n,
      activityTo: 9_000n + 6_000n, // 10m forward — also past head
      maxRange: 9999,
    });

    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) {
      expect(q.to).toBeLessThanOrEqual(10_000n);
      expect(q.from).toBeLessThanOrEqual(10_000n);
    }
  });

  it('uses a caller-supplied head instead of asking for one', async () => {
    const methods: string[] = [];
    const client = {
      request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
        methods.push(method);
        if (method === 'eth_blockNumber') return '0x2710';
        const p = params[0];
        expect(BigInt(p.toBlock)).toBeLessThanOrEqual(5_000n);
        return p.topics.length >= 4 ? [] : [];
      }),
    };

    await pickPrimaryV4Pool(client as never, {
      chainId: 4663,
      token: TOKEN,
      currentPoolId: null,
      scanFrom: 0n,
      scanTo: 72_000n,
      activityFrom: 0n,
      activityTo: 6_000n,
      maxRange: 9999,
      headBlock: 5_000n,
    });

    expect(methods).not.toContain('eth_blockNumber');
  });
});
