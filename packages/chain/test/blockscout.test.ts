import { describe, expect, it } from 'vitest';
import { BlockscoutClient, DEFAULT_BLOCKSCOUT_BASE, RH_CHAIN_ID, robinhoodChain } from '../src/index';
import addressFixture from './fixtures/address.json';

function fixtureFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('robinhoodChain', () => {
  it('is chain 4663', () => {
    expect(robinhoodChain.id).toBe(RH_CHAIN_ID);
    expect(RH_CHAIN_ID).toBe(4663);
  });
});

describe('BlockscoutClient', () => {
  it('defaults to the Robinhood Chain Blockscout v2 base', () => {
    expect(DEFAULT_BLOCKSCOUT_BASE).toBe('https://robinhoodchain.blockscout.com/api/v2');
  });

  it('parses an address response from a fixture (no network)', async () => {
    const client = new BlockscoutClient({
      baseUrl: 'https://example.test',
      fetchImpl: fixtureFetch(addressFixture),
    });
    const addr = await client.getAddress('0x1111111111111111111111111111111111111111');
    expect(addr.is_contract).toBe(true);
    expect(addr.creator_address_hash).toBe('0x2222222222222222222222222222222222222222');
  });

  it('throws on a non-2xx response', async () => {
    const client = new BlockscoutClient({
      baseUrl: 'https://example.test',
      fetchImpl: fixtureFetch({ message: 'nope' }, 404),
    });
    await expect(client.getTransaction('0xabc')).rejects.toThrow(/404/);
  });
});
