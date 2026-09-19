/**
 * M5b-3 / M5c — the `MetabolismSpend` ledger: one row per `llm_deepdive_v0` run.
 *
 * M5c: a row is never a bare number. It carries the token counts it was priced
 * from, the estimate, the pricing version, and a `costBasis` saying what kind
 * of figure `costUsd` is. The lifecycle runner reconciles each epoch's rows
 * against the provider's authoritative delta and relabels them
 * `provider_reconciled_estimate`. Idempotent on `generationId` when one exists
 * (never, through the Orbio gateway).
 */
import { prisma } from '@launch-auditor/db';
import type { CostBasis } from './reconcile';

export interface SpendEntry {
  /** best-available figure for display — `costBasis` says what it is */
  costUsd: number;
  /** pinned model slug the cost is for */
  model: string;
  /** sha256(gateway key)[:12] — ties the spend to a key generation */
  keyHashPrefix?: string | null;
  reportId?: string | null;
  /** OpenRouter generation id — the idempotency key, when the gateway surfaces one */
  generationId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCostUsd?: number | null;
  pricingVersion?: string | null;
  costBasis?: CostBasis;
}

export interface SpendFilter {
  since?: Date;
  keyHashPrefix?: string;
}

export interface SpendRow {
  costUsd: number;
  model: string;
  keyHashPrefix: string | null;
  reportId: string | null;
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
  pricingVersion: string | null;
  costBasis: CostBasis;
}

/** Storage seam so the ledger is unit-testable without Postgres. */
export interface SpendStore {
  findByGenerationId(generationId: string): Promise<{ id: string } | null>;
  insert(row: SpendRow): Promise<{ id: string }>;
  sum(filter: SpendFilter): Promise<number>;
  sumByKey(): Promise<Array<{ keyHashPrefix: string | null; totalUsd: number }>>;
  /** M5c: Σ estimatedCostUsd + row count for rows in (since, until] with no epoch yet.
   *  Optional on the seam so pre-M5c test fakes still satisfy it; `prismaSpendStore` implements it. */
  windowEstimate?(since: Date | null, until: Date): Promise<{ estimatedUsd: number; count: number }>;
  /** M5c: stamp the window's rows with the epoch and the reconciled figure */
  applyReconciliation?(args: {
    since: Date | null;
    until: Date;
    epochId: string;
    factor: number | null;
  }): Promise<number>;
}

export const prismaSpendStore: SpendStore = {
  findByGenerationId: (generationId) =>
    prisma.metabolismSpend.findFirst({ where: { generationId }, select: { id: true } }),
  insert: (row) => prisma.metabolismSpend.create({ data: row, select: { id: true } }),
  sum: async (filter) => {
    const agg = await prisma.metabolismSpend.aggregate({
      _sum: { costUsd: true },
      where: {
        ...(filter.since ? { at: { gte: filter.since } } : {}),
        ...(filter.keyHashPrefix ? { keyHashPrefix: filter.keyHashPrefix } : {}),
      },
    });
    return agg._sum.costUsd ?? 0;
  },
  sumByKey: async () => {
    const rows = await prisma.metabolismSpend.groupBy({
      by: ['keyHashPrefix'],
      _sum: { costUsd: true },
    });
    return rows.map((r) => ({ keyHashPrefix: r.keyHashPrefix, totalUsd: r._sum.costUsd ?? 0 }));
  },
  windowEstimate: async (since, until) => {
    const agg = await prisma.metabolismSpend.aggregate({
      _sum: { estimatedCostUsd: true },
      _count: { _all: true },
      where: { epochId: null, at: { ...(since ? { gt: since } : {}), lte: until } },
    });
    return { estimatedUsd: agg._sum.estimatedCostUsd ?? 0, count: agg._count._all };
  },
  applyReconciliation: async ({ since, until, epochId, factor }) => {
    const where = { epochId: null, at: { ...(since ? { gt: since } : {}), lte: until } };
    if (factor == null) {
      // nothing to scale by (idle window, or no provider delta) — just stamp the epoch
      const r = await prisma.metabolismSpend.updateMany({ where, data: { epochId } });
      return r.count;
    }
    // Prisma has no column-expression update; the window is small (one tick of runs)
    const rows = await prisma.metabolismSpend.findMany({
      where,
      select: { id: true, estimatedCostUsd: true },
    });
    let n = 0;
    for (const row of rows) {
      const reconciled =
        row.estimatedCostUsd != null ? Math.round(row.estimatedCostUsd * factor * 1e6) / 1e6 : null;
      await prisma.metabolismSpend.update({
        where: { id: row.id },
        data: {
          epochId,
          ...(reconciled != null
            ? { reconciledCostUsd: reconciled, costUsd: reconciled, costBasis: 'provider_reconciled_estimate' }
            : {}),
        },
      });
      n += 1;
    }
    return n;
  },
};

/** Record one deep-dive's spend. Idempotent when `generationId` is supplied. */
export async function recordSpend(
  entry: SpendEntry,
  store: SpendStore = prismaSpendStore,
): Promise<{ id: string; deduped: boolean }> {
  if (!Number.isFinite(entry.costUsd) || entry.costUsd < 0) {
    throw new Error(`recordSpend: costUsd must be a finite, non-negative number (got ${entry.costUsd})`);
  }
  if (!entry.model) throw new Error('recordSpend: model is required');

  if (entry.generationId) {
    const existing = await store.findByGenerationId(entry.generationId);
    if (existing) return { id: existing.id, deduped: true };
  }

  const { id } = await store.insert({
    costUsd: entry.costUsd,
    model: entry.model,
    keyHashPrefix: entry.keyHashPrefix ?? null,
    reportId: entry.reportId ?? null,
    generationId: entry.generationId ?? null,
    promptTokens: entry.promptTokens ?? null,
    completionTokens: entry.completionTokens ?? null,
    estimatedCostUsd: entry.estimatedCostUsd ?? null,
    pricingVersion: entry.pricingVersion ?? null,
    costBasis: entry.costBasis ?? 'unavailable',
  });
  return { id, deduped: false };
}

/** Σ costUsd, optionally since a time and/or for one key generation. */
export function totalSpendUsd(
  filter: SpendFilter = {},
  store: SpendStore = prismaSpendStore,
): Promise<number> {
  return store.sum(filter);
}

/** Per-`keyHashPrefix` spend totals (observability). */
export async function spendByKey(
  store: SpendStore = prismaSpendStore,
): Promise<Map<string | null, number>> {
  const rows = await store.sumByKey();
  return new Map(rows.map((r) => [r.keyHashPrefix, r.totalUsd]));
}

/** M5c: the un-reconciled rows in a window — what an epoch grades. */
export function windowEstimate(
  since: Date | null,
  until: Date,
  store: SpendStore = prismaSpendStore,
): Promise<{ estimatedUsd: number; count: number }> {
  if (!store.windowEstimate) return Promise.resolve({ estimatedUsd: 0, count: 0 });
  return store.windowEstimate(since, until);
}

/** M5c: stamp a window's rows with their epoch and reconciled figure. */
export function applyReconciliation(
  args: { since: Date | null; until: Date; epochId: string; factor: number | null },
  store: SpendStore = prismaSpendStore,
): Promise<number> {
  if (!store.applyReconciliation) return Promise.resolve(0);
  return store.applyReconciliation(args);
}
