import { describe, expect, it } from 'vitest';
import {
  recordSpend,
  spendByKey,
  totalSpendUsd,
  type SpendStore,
} from '../src/metabolism/spend-ledger';

/** In-memory SpendStore for the ledger's unit tests. */
function fakeStore(): SpendStore & { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async findByGenerationId(generationId) {
      const hit = rows.find((r) => r.generationId === generationId);
      return hit ? { id: hit.id as string } : null;
    },
    async insert(row) {
      const id = `spend-${rows.length + 1}`;
      rows.push({ id, ...row });
      return { id };
    },
    async sum(filter) {
      return rows
        .filter((r) => (filter.keyHashPrefix ? r.keyHashPrefix === filter.keyHashPrefix : true))
        .reduce((a, r) => a + (r.costUsd as number), 0);
    },
    async sumByKey() {
      const m = new Map<string | null, number>();
      for (const r of rows) {
        const k = (r.keyHashPrefix as string | null) ?? null;
        m.set(k, (m.get(k) ?? 0) + (r.costUsd as number));
      }
      return [...m].map(([keyHashPrefix, totalUsd]) => ({ keyHashPrefix, totalUsd }));
    },
  };
}

describe('recordSpend', () => {
  it('inserts a row', async () => {
    const store = fakeStore();
    const { id, deduped } = await recordSpend(
      { costUsd: 0.12, model: 'x/y', keyHashPrefix: 'sk-orbio-AAA', reportId: 'r1', generationId: 'g1' },
      store,
    );
    expect(deduped).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ id, costUsd: 0.12, model: 'x/y', generationId: 'g1' });
  });

  it('is idempotent on generationId', async () => {
    const store = fakeStore();
    const first = await recordSpend({ costUsd: 0.1, model: 'm', generationId: 'gen-42' }, store);
    const second = await recordSpend({ costUsd: 0.1, model: 'm', generationId: 'gen-42' }, store);
    expect(second).toEqual({ id: first.id, deduped: true });
    expect(store.rows).toHaveLength(1);
  });

  it('still inserts when no generationId is given', async () => {
    const store = fakeStore();
    await recordSpend({ costUsd: 0.05, model: 'm' }, store);
    await recordSpend({ costUsd: 0.05, model: 'm' }, store);
    expect(store.rows).toHaveLength(2);
  });

  it('rejects a negative or non-finite cost', async () => {
    const store = fakeStore();
    await expect(recordSpend({ costUsd: -1, model: 'm' }, store)).rejects.toThrow(/non-negative/);
    await expect(recordSpend({ costUsd: Number.NaN, model: 'm' }, store)).rejects.toThrow();
    await expect(recordSpend({ costUsd: 1, model: '' }, store)).rejects.toThrow(/model/);
  });
});

describe('totalSpendUsd / spendByKey', () => {
  it('sums all rows and filters by key', async () => {
    const store = fakeStore();
    await recordSpend({ costUsd: 0.2, model: 'm', keyHashPrefix: 'k1' }, store);
    await recordSpend({ costUsd: 0.3, model: 'm', keyHashPrefix: 'k1' }, store);
    await recordSpend({ costUsd: 0.5, model: 'm', keyHashPrefix: 'k2' }, store);

    expect(await totalSpendUsd({}, store)).toBeCloseTo(1.0, 6);
    expect(await totalSpendUsd({ keyHashPrefix: 'k1' }, store)).toBeCloseTo(0.5, 6);

    const byKey = await spendByKey(store);
    expect(byKey.get('k1')).toBeCloseTo(0.5, 6);
    expect(byKey.get('k2')).toBeCloseTo(0.5, 6);
  });
});
