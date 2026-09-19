import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatewayGetKey, gatewayKeyToReading, GatewayKeySchema, metabolismSource } from '../src/metabolism/gateway-reader';

// Recorded live 2026-09-16 (prefix redacted). The account had no activated
// balance, which is also why every deep-dive was returning 402.
const LIVE = readFileSync(join(__dirname, 'fixtures/orbio/gateway_get_key.json'), 'utf8');

const okFetch = (body: string, status = 200) =>
  (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('gateway GET /key — balance without an MCP session', () => {
  it('parses the recorded live response', () => {
    const k = GatewayKeySchema.parse(JSON.parse(LIVE));
    expect(k.balance.available).toBe('0');
    expect(k.key.prefix).toBe('sk-orbio-REDACTED');
  });

  it('maps to the reading the lifecycle runner consumes', () => {
    const r = gatewayKeyToReading(GatewayKeySchema.parse(JSON.parse(LIVE)));
    expect(r).toEqual({
      balanceUsd: 0,
      providerSpendUsd: 0.629913,
      status: { hasKey: true, prefix: 'sk-orbio-REDACTED', createdAt: '2026-09-12T00:39:36.233434+00:00' },
    });
  });

  it('reads exact decimal money, not floats-as-strings', () => {
    const body = JSON.parse(LIVE);
    body.balance.available = '12.34';
    expect(gatewayKeyToReading(GatewayKeySchema.parse(body)).balanceUsd).toBe(12.34);
    body.balance.available = '12,34';
    expect(() => GatewayKeySchema.parse(body)).toThrow();
  });

  it('calls {base}/key with the bearer key and surfaces non-200 with the body', async () => {
    let seen = '';
    const f = (async (url: string, init?: RequestInit) => {
      seen = `${url} ${(init?.headers as Record<string, string>).Authorization}`;
      return new Response(LIVE, { status: 200 });
    }) as unknown as typeof fetch;
    await gatewayGetKey({ baseUrl: 'https://gw.test/api/v1/', apiKey: 'sk-test', fetchImpl: f });
    expect(seen).toBe('https://gw.test/api/v1/key Bearer sk-test');
    await expect(
      gatewayGetKey({ baseUrl: 'https://gw.test/api/v1', apiKey: 'sk-test', fetchImpl: okFetch('{"error":"nope"}', 401) }),
    ).rejects.toThrow(/401.*nope/);
  });

  it('refuses to call without a key', async () => {
    await expect(gatewayGetKey({ baseUrl: 'https://gw.test', apiKey: '' })).rejects.toThrow(/no gateway key/);
  });
});

describe('metabolismSource', () => {
  it('defaults to the gateway; mcp only when asked', () => {
    expect(metabolismSource({})).toBe('gateway');
    expect(metabolismSource({ METABOLISM_SOURCE: 'MCP' })).toBe('mcp');
    expect(metabolismSource({ METABOLISM_SOURCE: 'something' })).toBe('gateway');
  });
});
