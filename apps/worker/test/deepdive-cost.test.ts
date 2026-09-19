import { describe, expect, it } from 'vitest';
import { recordDeepdiveSpend } from '../src/deepdive/cost';
import { PRICING_VERSION } from '../src/deepdive/pricing';
import type { SpendRow, SpendStore } from '../src/metabolism/spend-ledger';

function fakeStore(): SpendStore & { rows: Array<SpendRow & { id: string }> } {
  const rows: Array<SpendRow & { id: string }> = [];
  return {
    rows,
    async findByGenerationId(id) {
      const hit = rows.find((r) => r.generationId === id);
      return hit ? { id: hit.id } : null;
    },
    async insert(row) {
      const id = `s${rows.length + 1}`;
      rows.push({ id, ...row });
      return { id };
    },
    async sum() {
      return rows.reduce((a, r) => a + r.costUsd, 0);
    },
    async sumByKey() {
      return [];
    },
    async windowEstimate() {
      return { estimatedUsd: 0, count: 0 };
    },
    async applyReconciliation() {
      return 0;
    },
  };
}

type R = Parameters<typeof recordDeepdiveSpend>[0]['result'];
const result = (over: Partial<R> = {}): R => ({
  generationIds: [],
  modelSlug: 'sakana/fugu-max',
  usageCostUsd: null,
  promptTokens: 50_000,
  completionTokens: 5_000,
  ...over,
});

describe('recordDeepdiveSpend — every cost carries its basis (M5c)', () => {
  it('Orbio gateway shape: no cost, no generation ids, tokens present → token_estimate', async () => {
    const store = fakeStore();
    const out = await recordDeepdiveSpend({ result: result(), keyHashPrefix: 'kp1', reportId: 'r1' }, { store });
    expect(out.costBasis).toBe('token_estimate');
    expect(out.totalCostUsd).toBeCloseTo(0.13, 6); // 50k@$2/M + 5k@$6/M
    expect(out.estimatedCostUsd).toBeCloseTo(0.13, 6);
    expect(out.failed).toEqual([]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      costUsd: 0.13,
      costBasis: 'token_estimate',
      promptTokens: 50_000,
      completionTokens: 5_000,
      pricingVersion: PRICING_VERSION,
      keyHashPrefix: 'kp1',
      reportId: 'r1',
      generationId: null,
    });
  });

  it('a provider-reported cost wins and is labelled as such, estimate kept alongside', async () => {
    const store = fakeStore();
    const out = await recordDeepdiveSpend({ result: result({ usageCostUsd: 0.1182 }) }, { store });
    expect(out.costBasis).toBe('provider_reported');
    expect(out.totalCostUsd).toBeCloseTo(0.1182, 6);
    expect(store.rows[0]?.estimatedCostUsd).toBeCloseTo(0.13, 6);
  });

  it('generation lookups that all succeed → provider_generation, summed', async () => {
    const store = fakeStore();
    const costs: Record<string, number> = { 'gen-a': 0.012, 'gen-b': 0.008 };
    const out = await recordDeepdiveSpend(
      { result: result({ generationIds: ['gen-a', 'gen-b'] }) },
      { store, lookupCost: async (id) => costs[id]! },
    );
    expect(out.costBasis).toBe('provider_generation');
    expect(out.totalCostUsd).toBeCloseTo(0.02, 6);
    expect(store.rows[0]?.generationId).toBe('gen-a');
  });

  it('a failed generation lookup (the Orbio 404) falls back to the token estimate — never $0, never silent', async () => {
    const store = fakeStore();
    const out = await recordDeepdiveSpend(
      { result: result({ generationIds: ['gen-a'] }) },
      {
        store,
        lookupCost: async (id) => {
          throw new Error(`generation lookup ${id}: HTTP 404`);
        },
      },
    );
    expect(out.failed).toEqual(['gen-a']);
    expect(out.failureReason).toMatch(/404/);
    expect(out.costBasis).toBe('token_estimate');
    expect(out.totalCostUsd).toBeCloseTo(0.13, 6);
  });

  it('nothing to price at all → unavailable with cost 0, not a fabricated number', async () => {
    const store = fakeStore();
    const out = await recordDeepdiveSpend(
      { result: result({ promptTokens: null, completionTokens: null }) },
      { store },
    );
    expect(out.costBasis).toBe('unavailable');
    expect(out.totalCostUsd).toBe(0);
    expect(out.estimatedCostUsd).toBeNull();
    expect(store.rows[0]).toMatchObject({ costUsd: 0, costBasis: 'unavailable', pricingVersion: null });
  });

  it('an unpriced model with tokens is unavailable, not guessed', async () => {
    const store = fakeStore();
    const out = await recordDeepdiveSpend({ result: result({ modelSlug: 'x/unknown' }) }, { store });
    expect(out.costBasis).toBe('unavailable');
    expect(out.estimatedCostUsd).toBeNull();
  });

  it('is idempotent on a generation id', async () => {
    const store = fakeStore();
    const args = { result: result({ generationIds: ['gen-a'] }) };
    const deps = { store, lookupCost: async () => 0.01 };
    const a = await recordDeepdiveSpend(args, deps);
    const b = await recordDeepdiveSpend(args, deps);
    expect(a.rows[0]?.deduped).toBe(false);
    expect(b.rows[0]?.deduped).toBe(true);
    expect(store.rows).toHaveLength(1);
  });
});
