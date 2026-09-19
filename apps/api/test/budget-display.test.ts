import { dailyDeepdiveBudget, deepdiveRunGate } from '@launch-auditor/db';
import { describe, expect, it } from 'vitest';
import { budgetDisplay, type BudgetDisplayInputs } from '../src/budget-display';

const BASE: BudgetDisplayInputs = {
  dailyCapUsd: 5,
  capPerRunUsd: 0.2,
  todaySpendUsd: 0,
  providerSpendTodayUsd: 0,
  balanceUsd: 10,
  reserveUsd: 3,
};

describe('budgetDisplay — the same calculation as the worker gate', () => {
  // 2026-09-19 audit counterexample. Live state: $5 configured cap, $1 CREDIT
  // share (2 CREDIT activated in 24h), $25.42 balance, $0.20 per-run cap.
  // After $0.90 spent the worker allows $0.10; the old display said $0.20 and
  // "$4.10 remaining".
  const audit: BudgetDisplayInputs = {
    dailyCapUsd: 5,
    capPerRunUsd: 0.2,
    todaySpendUsd: 0.9,
    providerSpendTodayUsd: 0,
    balanceUsd: 25.42,
    reserveUsd: 0.5,
    trailingCreditsUsd: 2,
  };

  it('allows $0.10 after $0.90 spent, exactly as the worker does', () => {
    const b = budgetDisplay(audit);
    expect(b.effectiveDailyCapUsd).toBe(1);
    expect(b.effectiveCapBinding).toBe('credit_share');
    expect(b.remainingTodayUsd).toBe(0.1);
    expect(b.maxRunCostUsd).toBe(0.1);
    expect(b.capSource).toBe('credit_linked');
  });

  it('agrees with a direct run of the worker functions', () => {
    const spendable = audit.balanceUsd! - audit.reserveUsd;
    const cap = dailyDeepdiveBudget({ dailyCapUsd: 5, trailingCreditsUsd: 2, keyRemainingUsd: audit.balanceUsd!, reserveUsd: 0.5 }).budgetUsd;
    const gate = deepdiveRunGate({ capPerRunUsd: 0.2, dailyCapUsd: cap, todaySpendUsd: 0.9, providerSpendTodayUsd: 0, spendableUsd: spendable });
    const b = budgetDisplay(audit);
    expect([b.remainingTodayUsd, b.maxRunCostUsd, b.allowed]).toEqual([gate.remainingTodayUsd, gate.maxRunCostUsd, gate.allowed]);
  });

  it('checks the cap against the larger of ledger and provider spend', () => {
    const b = budgetDisplay({ ...audit, todaySpendUsd: 0.2, providerSpendTodayUsd: 0.95 });
    expect(b.spentTodayUsd).toBe(0.95);
    expect(b.remainingTodayUsd).toBe(0.05);
  });

  it('says so when CREDIT is unreadable and the flat cap applies — as the worker falls back', () => {
    const b = budgetDisplay({ ...BASE });
    expect(b.capSource).toBe('flat_fallback');
    expect(b.effectiveDailyCapUsd).toBe(5);
    expect(b.creditShareUsd).toBeNull();
  });

  it('refuses a run once the effective cap is spent, with the worker reason', () => {
    const b = budgetDisplay({ ...audit, todaySpendUsd: 1 });
    expect(b.allowed).toBe(false);
    expect(b.maxRunCostUsd).toBe(0);
    expect(b.reason).toMatch(/daily cap/);
  });

  it('refuses at or under the reserve', () => {
    const b = budgetDisplay({ ...BASE, balanceUsd: 2, reserveUsd: 3 });
    expect(b.allowed).toBe(false);
    expect(b.spendableUsd).toBe(0);
    expect(b.maxRunCostUsd).toBe(0);
  });

  it('closes on anomaly or phantom billing, and only those', () => {
    for (const s of ['anomaly', 'phantom']) {
      const b = budgetDisplay({ ...BASE, billingStatus: s });
      expect(b.gateClosedByBilling).toBe(true);
      expect(b.allowed).toBe(false);
    }
    for (const s of ['exact', 'aggregate_only', 'unavailable', 'stale', null, undefined]) {
      expect(budgetDisplay({ ...BASE, billingStatus: s }).gateClosedByBilling).toBe(false);
    }
  });

  it('reports a stale balance and a never-read balance, without inventing zero', () => {
    expect(budgetDisplay({ ...BASE, billingStatus: 'stale' }).balanceStale).toBe(true);
    const unknown = budgetDisplay({ ...BASE, balanceUsd: null });
    expect(unknown.balanceUnknown).toBe(true);
    expect(unknown.spendableUsd).toBe(5); // the worker treats the daily cap as spendable
    expect(unknown.maxRunCostUsd).toBe(0.2);
  });
});
