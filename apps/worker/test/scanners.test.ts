import { describe, expect, it } from 'vitest';
import goplusCapy from './fixtures/goplus-capy.json';
import scanhoodCapy from './fixtures/scanhood-capy.json';
import { fetchGoPlus, mapGoPlus, taxToBps } from '../src/scanners/goplus';
import { fetchScanHoodScan, mapScanHood } from '../src/scanners/scanhood';

const CAPY = '0x75A2Fd89dBdE6F0b93B1A1E2ED35712665043682';

const jsonFetch = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

describe('GoPlus (recorded CAPY fixture)', () => {
  it('parses the token_security result', async () => {
    const r = await fetchGoPlus(CAPY, { fetchImpl: jsonFetch(goplusCapy) });
    expect(r.ok).toBe(true);
    expect(r.security?.is_open_source).toBe('1');
  });

  it('maps to typed feature-9 fields', () => {
    const parsed = goplusCapy as { result: Record<string, Record<string, string>> };
    const m = mapGoPlus(parsed.result[CAPY.toLowerCase()]!);
    expect(m.verified).toBe(true); // is_open_source "1"
    expect(m.mintable).toBe(false); // is_mintable "0"
    expect(m.honeypot).toBe(false); // is_honeypot "0"
    expect(m.sellTaxBps).toBeNull(); // sell_tax ""
  });

  it('taxToBps converts a decimal-fraction string', () => {
    expect(taxToBps('0.05')).toBe(500);
    expect(taxToBps('')).toBeNull();
    expect(taxToBps(undefined)).toBeNull();
  });

  it('returns ok:false on a network error', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const r = await fetchGoPlus(CAPY, { fetchImpl: boom });
    expect(r.ok).toBe(false);
    expect(r.security).toBeNull();
  });
});

describe('ScanHood (recorded CAPY fixture)', () => {
  it('parses the scan response', async () => {
    const r = await fetchScanHoodScan(CAPY, { fetchImpl: jsonFetch(scanhoodCapy) });
    expect(r.ok).toBe(true);
    expect(r.data?.market?.liq).toBeCloseTo(5140.66, 1);
  });

  it('maps to typed feature-9 fields', () => {
    const m = mapScanHood(scanhoodCapy as never);
    expect(m.lpHolderType).toBe('v3/other'); // lp.status is "unknown" -> falls back to lp.type
    expect(m.liquidityUsd).toBeCloseTo(5140.66, 1);
    expect(m.isImpostorRwa).toBeNull(); // rwa null
  });

  it('flags an error body as not ok', async () => {
    const r = await fetchScanHoodScan(CAPY, {
      fetchImpl: jsonFetch({ error: 'no pool with liquidity for this token' }),
    });
    expect(r.ok).toBe(false);
  });
});
