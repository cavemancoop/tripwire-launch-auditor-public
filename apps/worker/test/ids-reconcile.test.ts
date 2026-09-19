import { describe, expect, it } from 'vitest';
import { reconcileIds, type SpendBaseline } from '../src/metabolism/ids-reconcile';

const baseline: SpendBaseline = {
  keyPrefix: 'sk-orbio-ABC123',
  providerSpentUsd: 10,
  ledgerUsd: 10,
  at: '2026-09-09T00:00:00.000Z',
};
const cfg = { toleranceUsd: 0.01, graceUsd: 0.25 };

describe('reconcileIds (M5b-3 per-key IDS)', () => {
  it('no baseline → cannot reconcile, no mismatch', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-ABC123',
      providerSpentUsd: 999,
      ledgerSpendUsd: 0,
      baseline: null,
      ...cfg,
    });
    expect(r).toMatchObject({ mismatch: false, direction: 'no_baseline' });
  });

  it('baseline belongs to a different key → cannot reconcile', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-NEWKEY',
      providerSpentUsd: 50,
      ledgerSpendUsd: 10,
      baseline,
      ...cfg,
    });
    expect(r.direction).toBe('no_baseline');
    expect(r.mismatch).toBe(false);
  });

  it('no current key → no_baseline', () => {
    const r = reconcileIds({ keyPrefix: null, providerSpentUsd: 20, ledgerSpendUsd: 10, baseline, ...cfg });
    expect(r.direction).toBe('no_baseline');
  });

  it('provider outpaces the ledger beyond the grace band → mismatch', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-ABC123',
      providerSpentUsd: 12, // +2 since baseline
      ledgerSpendUsd: 10.5, // +0.5 since baseline
      baseline,
      ...cfg,
    });
    expect(r).toMatchObject({ mismatch: true, direction: 'provider_ahead' });
    expect(r.providerDeltaUsd).toBeCloseTo(2, 6);
    expect(r.ledgerDeltaUsd).toBeCloseTo(0.5, 6);
    expect(r.excessUsd).toBeCloseTo(1.5, 6);
  });

  it('provider slightly ahead but within grace → ok', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-ABC123',
      providerSpentUsd: 10.2, // +0.2, one in-flight deep-dive not yet recorded
      ledgerSpendUsd: 10,
      baseline,
      ...cfg,
    });
    expect(r).toMatchObject({ mismatch: false, direction: 'ok' });
  });

  it('ledger ahead of provider (unsettled / over-recorded) → not a mismatch', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-ABC123',
      providerSpentUsd: 10,
      ledgerSpendUsd: 13, // we recorded $3 the gateway has not billed
      baseline,
      ...cfg,
    });
    expect(r).toMatchObject({ mismatch: false, direction: 'ledger_ahead' });
    expect(r.excessUsd).toBeCloseTo(-3, 6);
  });

  it('exact match → ok', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-ABC123',
      providerSpentUsd: 15,
      ledgerSpendUsd: 15,
      baseline,
      ...cfg,
    });
    expect(r).toMatchObject({ mismatch: false, direction: 'ok', excessUsd: 0 });
  });

  it('tolerance floor applies when grace is tiny', () => {
    const r = reconcileIds({
      keyPrefix: 'sk-orbio-ABC123',
      providerSpentUsd: 10.005, // +0.005, below the 0.01 tolerance
      ledgerSpendUsd: 10,
      baseline,
      toleranceUsd: 0.01,
      graceUsd: 0,
    });
    expect(r.mismatch).toBe(false);
  });
});
