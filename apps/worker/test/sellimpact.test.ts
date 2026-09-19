import { describe, expect, it, vi } from 'vitest';
import { quoteSellImpact } from '../src/watcher/sellimpact';

const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const TOKEN = '0x00000000000000000000000000000000000000ff';
const QUOTE = '0x0000000000000000000000000000000000000011'; // sorts below TOKEN

const enc = (out: bigint): string =>
  `0x${out.toString(16).padStart(64, '0')}${(21000n).toString(16).padStart(64, '0')}`;

/** returns a value per eth_call, in call order: [spot, notional[0], notional[1], …] */
function quoterClient(perCall: Array<bigint | 'revert'>) {
  let n = 0;
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_call') throw new Error(method);
      const v = perCall[n++];
      if (v === 'revert') throw new Error('execution reverted');
      return enc(v as bigint);
    }),
  };
}

const NOTIONALS = [100n * 10n ** 6n, 1000n * 10n ** 6n]; // 100 / 1,000 units at 6 decimals

describe('quoteSellImpact (fixed quote-unit notionals)', () => {
  it('reports impact bps per notional off the spot quote', async () => {
    // spot: in 1e12 -> out 1e12 (spotPer = 1). n100 sellSize 1e8, out 0.97e8 -> 300bps.
    // n1000 sellSize 1e9, out 0.90e9 -> 1000bps.
    const client = quoterClient([10n ** 12n, 97_000_000n, 900_000_000n]);
    const r = await quoteSellImpact({
      client: client as never,
      quoter: QUOTER,
      token: TOKEN,
      quote: QUOTE,
      fee: 3000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
      notionalsQuote: NOTIONALS,
    });
    expect(r.spotOk).toBe(true);
    expect(r.results.map((x) => x.impactBps)).toEqual([300, 1000]);
    expect(r.results.map((x) => x.simOk)).toEqual([true, true]);
    expect(r.results[0]!.notionalQuote).toBe(NOTIONALS[0]);
  });

  it('clamps negative impact (a better-than-spot rate) to 0', async () => {
    const client = quoterClient([10n ** 12n, 101_000_000n, 1_010_000_000n]);
    const r = await quoteSellImpact({
      client: client as never,
      quoter: QUOTER,
      token: TOKEN,
      quote: QUOTE,
      fee: 3000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
      notionalsQuote: NOTIONALS,
    });
    expect(r.results.map((x) => x.impactBps)).toEqual([0, 0]);
  });

  it('marks spotOk false and every notional null when the spot quote reverts', async () => {
    const client = quoterClient(['revert']);
    const r = await quoteSellImpact({
      client: client as never,
      quoter: QUOTER,
      token: TOKEN,
      quote: QUOTE,
      fee: 3000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
      notionalsQuote: NOTIONALS,
    });
    expect(r.spotOk).toBe(false);
    expect(r.results.every((x) => x.impactBps === null && x.simOk === false)).toBe(true);
  });

  it('marks one notional null when only its bulk quote reverts', async () => {
    const client = quoterClient([10n ** 12n, 97_000_000n, 'revert']);
    const r = await quoteSellImpact({
      client: client as never,
      quoter: QUOTER,
      token: TOKEN,
      quote: QUOTE,
      fee: 3000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
      notionalsQuote: NOTIONALS,
    });
    expect(r.results[0]!.impactBps).toBe(300);
    expect(r.results[1]!.impactBps).toBeNull();
    expect(r.results[1]!.simOk).toBe(false);
  });
});
