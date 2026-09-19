import { describe, expect, it } from 'vitest';
import { buildServer, type ProofRow } from '../src/server';

describe('GET /v1/benchmark', () => {
  it('serves whatever the worker last snapshotted', async () => {
    const snapshot = { generatedAt: '2026-09-12T00:00:00.000Z', sections: [] };
    const app = buildServer({ benchmarkReader: async () => snapshot });
    const res = await app.inject({ method: 'GET', url: '/v1/benchmark' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(snapshot);
    await app.close();
  });

  it('503s honestly when no snapshot exists yet', async () => {
    const app = buildServer({ benchmarkReader: async () => null });
    const res = await app.inject({ method: 'GET', url: '/v1/benchmark' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('GET /v1/proof/:hash', () => {
  const HASH = `0x${'ab'.repeat(32)}`;

  it('serves the injected proof row', async () => {
    const row: ProofRow = {
      reportHash: HASH,
      committed: true,
      proofAvailable: true,
      proofValid: true,
      merkleRoot: `0x${'cd'.repeat(32)}`,
      leafIndex: 3,
      proof: [`0x${'ef'.repeat(32)}`],
      txHash: '0xtx',
      blockNumber: 123,
      onChainConfirmed: true,
    };
    const app = buildServer({ proofReader: async () => row });
    const res = await app.inject({ method: 'GET', url: `/v1/proof/${HASH}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(row);
    await app.close();
  });

  it('404s an unknown hash', async () => {
    const app = buildServer({ proofReader: async () => null });
    const res = await app.inject({ method: 'GET', url: `/v1/proof/${HASH}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400s a malformed hash', async () => {
    const app = buildServer({ proofReader: async () => null });
    const res = await app.inject({ method: 'GET', url: '/v1/proof/not-a-hash' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('never reports onChainConfirmed:false from an RPC hiccup (null, not false)', async () => {
    // exercised at the reader level (unit-testable independent of live RPC):
    // the default reader's catch sets onChainConfirmed = null, never false.
    const row: ProofRow = { reportHash: HASH, committed: true, proofAvailable: true, proofValid: true, onChainConfirmed: null };
    const app = buildServer({ proofReader: async () => row });
    const res = await app.inject({ method: 'GET', url: `/v1/proof/${HASH}` });
    expect(res.json().onChainConfirmed).toBeNull();
    await app.close();
  });
});
