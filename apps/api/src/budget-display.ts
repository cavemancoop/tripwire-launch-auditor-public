/**
 * The dashboard's view of the deep-dive budget gate — computed with the
 * worker's own functions (`@launch-auditor/db`) over the worker's own spend
 * window (UTC day), so the panel and the gate can't disagree. The 2026-09-19
 * audit found the old display, a hand-kept copy on a trailing-24h window,
 * allowing $0.20 after $0.90 spent where the worker allowed $0.10.
 */
import { dailyDeepdiveBudget, deepdiveRunGate } from '@launch-auditor/db';

export interface BudgetDisplayInputs {
  /** DEEPDIVE_DAILY_CAP_USD — the configured ceiling */
  dailyCapUsd: number;
  capPerRunUsd: number;
  /** Σ local ledger spend since 00:00 UTC */
  todaySpendUsd: number;
  /** Σ provider-reconciled spend since 00:00 UTC */
  providerSpendTodayUsd: number;
  /** latest AI balance read; null = never read (the worker then treats the daily cap as spendable) */
  balanceUsd: number | null;
  reserveUsd: number;
  billingStatus?: string | null;
  /** CREDIT activated into the agent's account in the trailing 24h; undefined when not readable/configured */
  trailingCreditsUsd?: number;
}

export interface BudgetDisplay {
  /** the configured ceiling (DEEPDIVE_DAILY_CAP_USD) */
  dailyCapUsd: number;
  /** what the gate actually uses: min(ceiling, 50% of trailing CREDIT, spendable) */
  effectiveDailyCapUsd: number;
  effectiveCapBinding: 'daily_cap' | 'credit_share' | 'key_reserve' | 'zero';
  /** credit_linked = the cap follows on-chain CREDIT; flat_fallback = CREDIT unreadable/unconfigured, the configured cap applies */
  capSource: 'credit_linked' | 'flat_fallback';
  creditShareUsd: number | null;
  capPerRunUsd: number;
  /** larger of ledger and provider spend since 00:00 UTC — the worker's window */
  spentTodayUsd: number;
  spendWindow: 'utc_day';
  remainingTodayUsd: number;
  spendableUsd: number;
  maxRunCostUsd: number;
  allowed: boolean;
  /** the worker gate's own reason string for this state */
  reason: string;
  gateClosedByBilling: boolean;
  /** the balance behind these numbers has not been re-read recently */
  balanceStale: boolean;
  /** no balance has ever been read — spendable falls back to the daily cap, as in the worker */
  balanceUnknown: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function budgetDisplay(i: BudgetDisplayInputs): BudgetDisplay {
  const balanceUnknown = i.balanceUsd === null;
  // apps/worker/src/deepdive/run.ts defaultLoadBudget: no balance read → the daily cap is the spendable figure
  const spendableUsd = i.balanceUsd === null ? i.dailyCapUsd : i.balanceUsd - i.reserveUsd;

  const creditLinked = i.trailingCreditsUsd !== undefined;
  const eff = creditLinked
    ? dailyDeepdiveBudget({
        dailyCapUsd: i.dailyCapUsd,
        trailingCreditsUsd: i.trailingCreditsUsd!,
        keyRemainingUsd: spendableUsd + i.reserveUsd, // dailyDeepdiveBudget re-subtracts the reserve
        reserveUsd: i.reserveUsd,
      })
    : null;
  const effectiveDailyCapUsd = eff ? eff.budgetUsd : i.dailyCapUsd;

  const gate = deepdiveRunGate({
    capPerRunUsd: i.capPerRunUsd,
    dailyCapUsd: effectiveDailyCapUsd,
    todaySpendUsd: i.todaySpendUsd,
    providerSpendTodayUsd: i.providerSpendTodayUsd,
    spendableUsd,
    billingStatus: i.billingStatus ?? null,
  });

  return {
    dailyCapUsd: round2(i.dailyCapUsd),
    effectiveDailyCapUsd: round2(effectiveDailyCapUsd),
    effectiveCapBinding: eff ? eff.bindingConstraint : 'daily_cap',
    capSource: creditLinked ? 'credit_linked' : 'flat_fallback',
    creditShareUsd: eff ? eff.creditShareUsd : null,
    capPerRunUsd: round2(i.capPerRunUsd),
    spentTodayUsd: round2(Math.max(i.todaySpendUsd, i.providerSpendTodayUsd)),
    spendWindow: 'utc_day',
    remainingTodayUsd: gate.remainingTodayUsd,
    spendableUsd: round2(Math.max(0, spendableUsd)),
    maxRunCostUsd: gate.allowed ? gate.maxRunCostUsd : 0,
    allowed: gate.allowed,
    reason: gate.reason,
    gateClosedByBilling: i.billingStatus === 'anomaly' || i.billingStatus === 'phantom',
    balanceStale: gate.balanceStale,
    balanceUnknown,
  };
}
