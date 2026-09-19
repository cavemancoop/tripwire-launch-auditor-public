/**
 * Turn a completed deep-dive run into one `MetabolismSpend` row (M5b-3 / M5c).
 *
 * M5c: the row records *what kind of number* its cost is. Precedence:
 *   1. `provider_reported`   — the gateway put a dollar cost in the usage object (OpenRouter does)
 *   2. `provider_generation` — every `GET /generation?id=` lookup succeeded (OpenRouter does; Orbio 404s)
 *   3. `token_estimate`      — token counts × the pinned model's published price (pricing.ts)
 *   4. `unavailable`         — none of the above; cost 0, and the epoch reconciler marks the
 *                              window `unavailable` rather than inventing a figure
 * The lifecycle runner later reconciles estimates against the provider's
 * authoritative delta and relabels them `provider_reconciled_estimate`.
 */
import type { WorkerEnv } from '../env';
import { recordSpend, type SpendStore } from '../metabolism/spend-ledger';
import type { CostBasis } from '../metabolism/reconcile';
import { generationCost, type GenerationCostDeps } from './openrouter';
import { estimateCostUsd, PRICING_VERSION } from './pricing';
import type { DeepDiveResult } from './schema';

export interface RecordDeepdiveSpendInput {
  result: Pick<
    DeepDiveResult,
    'generationIds' | 'modelSlug' | 'usageCostUsd' | 'promptTokens' | 'completionTokens'
  >;
  /** sha256(gateway key)[:12], from the Metabolism store */
  keyHashPrefix?: string | null;
  reportId?: string | null;
}

export interface RecordDeepdiveSpendDeps {
  env?: WorkerEnv;
  costDeps?: GenerationCostDeps;
  store?: SpendStore;
  /** override the per-generation cost lookup (tests) */
  lookupCost?: (id: string) => Promise<number>;
}

export interface RecordDeepdiveSpendResult {
  /** the figure recorded as `costUsd` */
  totalCostUsd: number;
  /** always set by `recordDeepdiveSpend`; optional so a mocked recorder can omit it */
  costBasis?: CostBasis;
  /** the token-priced estimate, recorded alongside whatever basis won */
  estimatedCostUsd?: number | null;
  rows: Array<{ id: string; deduped: boolean }>;
  /** generation lookups that failed (informational — the run still gets a row) */
  failed: string[];
  failureReason?: string;
}

export async function recordDeepdiveSpend(
  input: RecordDeepdiveSpendInput,
  deps: RecordDeepdiveSpendDeps = {},
): Promise<RecordDeepdiveSpendResult> {
  const { result } = input;
  const lookup =
    deps.lookupCost ??
    (async (id: string) => (await generationCost(id, deps.env, deps.costDeps)).totalCostUsd);

  const estimatedCostUsd = estimateCostUsd(result.modelSlug, result.promptTokens, result.completionTokens);
  const failed: string[] = [];
  let failureReason: string | undefined;

  let costUsd: number;
  let costBasis: CostBasis;

  if (result.usageCostUsd != null && Number.isFinite(result.usageCostUsd)) {
    costUsd = result.usageCostUsd;
    costBasis = 'provider_reported';
  } else {
    let generationTotal: number | null = null;
    if (result.generationIds.length > 0) {
      let sum = 0;
      for (const id of result.generationIds) {
        try {
          sum += await lookup(id);
        } catch (err) {
          failed.push(id);
          failureReason ??= err instanceof Error ? err.message : String(err);
        }
      }
      if (failed.length === 0) generationTotal = sum;
    }
    if (generationTotal != null) {
      costUsd = generationTotal;
      costBasis = 'provider_generation';
    } else if (estimatedCostUsd != null) {
      costUsd = estimatedCostUsd;
      costBasis = 'token_estimate';
    } else {
      costUsd = 0;
      costBasis = 'unavailable';
    }
  }

  const { id, deduped } = await recordSpend(
    {
      costUsd,
      model: result.modelSlug,
      keyHashPrefix: input.keyHashPrefix ?? null,
      reportId: input.reportId ?? null,
      generationId: result.generationIds[0] ?? null,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      estimatedCostUsd,
      pricingVersion: estimatedCostUsd != null ? PRICING_VERSION : null,
      costBasis,
    },
    deps.store,
  );

  return {
    totalCostUsd: Math.round(costUsd * 1e6) / 1e6,
    costBasis,
    estimatedCostUsd,
    rows: [{ id, deduped }],
    failed,
    ...(failureReason ? { failureReason } : {}),
  };
}
