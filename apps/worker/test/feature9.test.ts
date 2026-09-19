import { describe, expect, it, vi } from 'vitest';
import goplusCapy from './fixtures/goplus-capy.json';
import scanhoodCapy from './fixtures/scanhood-capy.json';
import { computeFeature9 } from '../src/watcher/feature9';

const TOKEN = '0x75a2fd89dbde6f0b93b1a1e2ed35712665043682';
const QUOTE = '0x0000000000000000000000000000000000000011';
const QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';

const jsonFetch = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

const encReturn = (out: bigint): string =>
  `0x${out.toString(16).padStart(64, '0')}${(21000n).toString(16).padStart(64, '0')}`;

describe('computeFeature9', () => {
  it('combines GoPlus + ScanHood + own quote into typed fields', async () => {
    let n = 0;
    const client = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method !== 'eth_call') throw new Error(method);
        // spot then bulk; bulk 5% worse
        return encReturn(n++ === 0 ? 1_000_000n : 950_000n);
      }),
    };

    const r = await computeFeature9({
      client: client as never,
      token: TOKEN,
      quote: QUOTE,
      quoter: QUOTER,
      poolFee: 3000,
      poolTickSpacing: 60,
      poolHooks: null,
      quoteDecimals: 6,
      goplus: { fetchImpl: jsonFetch(goplusCapy) },
      scanhood: { fetchImpl: jsonFetch(scanhoodCapy) },
    });

    expect(r.verified).toBe(true); // GoPlus is_open_source "1"
    expect(r.mintable).toBe(false);
    expect(r.liquidityUsd10m).toBeCloseTo(5140.66, 1); // ScanHood market.liq
    expect(r.lpHolderType).toBe('v3/other');
    expect(r.sellImpactBps100).not.toBeUndefined();
    expect(r.sellImpactBps).toBe(r.sellImpactBps1000); // "holder-sized" alias
    expect(r.sellSimOk).toBe(true); // GoPlus not-honeypot / own quote ok
    expect(r.goplusFetchedAt).toBeInstanceOf(Date);
    expect(r.scanhoodFetchedAt).toBeInstanceOf(Date);
    expect(r.crossCheck.verified).toBeDefined();
  });

  it('degrades gracefully when both scanners are unreachable', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = { request: vi.fn(async () => encReturn(0n)) };

    const r = await computeFeature9({
      client: client as never,
      token: TOKEN,
      quote: null, // no quote asset -> skip own sell quote too
      quoter: QUOTER,
      poolFee: null,
      poolTickSpacing: null,
      poolHooks: null,
      quoteDecimals: 18,
      goplus: { fetchImpl: boom },
      scanhood: { fetchImpl: boom },
    });

    expect(r.verified).toBeNull();
    expect(r.sellImpactBps).toBeNull();
    expect(r.sellImpactBps100).toBeNull();
    expect(r.sellImpactBps1000).toBeNull();
    expect(r.liquidityUsd10m).toBeNull();
  });
});
