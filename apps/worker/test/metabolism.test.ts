import { describe, expect, it } from 'vitest';
import {
  buildLifecycleEntry,
  dailyDeepdiveBudget,
  deepdiveRunGate,
  daysSinceLastManualAction,
  daysUnattended,
  decryptToken,
  encryptToken,
  GENESIS_HASH,
  generateEncryptionKey,
  loadEncryptionKey,
  manualReason,
  nextState,
  reserveUsd,
  runsAffordable,
  signLifecycleEntry,
  verifyLifecycleChain,
} from '../src/metabolism';

describe('nextState (spec §8 state machine)', () => {
  it('NO_KEY -> ACTIVE on KEY_CLAIMED', () => {
    expect(nextState('NO_KEY', 'KEY_CLAIMED')?.state).toBe('ACTIVE');
  });
  it('ACTIVE -> DRAINING -> ROTATING -> ACTIVE', () => {
    expect(nextState('ACTIVE', 'LOW_BALANCE')?.state).toBe('DRAINING');
    expect(nextState('DRAINING', 'DRAINED')?.state).toBe('ROTATING');
    expect(nextState('ROTATING', 'ROTATED')?.state).toBe('ACTIVE');
  });
  it('hygiene rotation from ACTIVE', () => {
    expect(nextState('ACTIVE', 'HYGIENE_DUE')?.state).toBe('ROTATING');
  });
  it('IDS mismatch -> REVOKING from any keyed state, then NO_KEY (retired edge, kept for old rows)', () => {
    expect(nextState('ACTIVE', 'IDS_MISMATCH')?.state).toBe('REVOKING');
    expect(nextState('DRAINING', 'IDS_MISMATCH')?.state).toBe('REVOKING');
    expect(nextState('NO_KEY', 'IDS_MISMATCH')).toBeNull();
    expect(nextState('REVOKING', 'REVOKED')?.state).toBe('NO_KEY');
  });
  it('PHANTOM_SPEND (M5c) -> REVOKING from any keyed state — the live compromise signal', () => {
    expect(nextState('ACTIVE', 'PHANTOM_SPEND')?.state).toBe('REVOKING');
    expect(nextState('DRAINING', 'PHANTOM_SPEND')?.state).toBe('REVOKING');
    expect(nextState('ROTATING', 'PHANTOM_SPEND')?.state).toBe('REVOKING');
    expect(nextState('STARVED', 'PHANTOM_SPEND')?.state).toBe('REVOKING');
    expect(nextState('NO_KEY', 'PHANTOM_SPEND')).toBeNull();
    expect(nextState('ACTIVE', 'PHANTOM_SPEND')?.reason).toMatch(/phantom/);
  });
  it('STARVED when there are no credits, and recovery', () => {
    expect(nextState('DRAINING', 'NO_CREDITS')?.state).toBe('STARVED');
    expect(nextState('NO_KEY', 'NO_CREDITS')?.state).toBe('STARVED');
    expect(nextState('STARVED', 'CREDITS_RETURNED')?.state).toBe('ROTATING');
  });
  it('returns null for events that do not apply', () => {
    expect(nextState('ACTIVE', 'ROTATED')).toBeNull();
    expect(nextState('REVOKING', 'STATUS_OK')).toBeNull();
  });
});

describe('dailyDeepdiveBudget (spec §8 policy)', () => {
  it('takes the min of daily cap, half the trailing credits, and spendable key', () => {
    const r = dailyDeepdiveBudget({
      dailyCapUsd: 5,
      trailingCreditsUsd: 6, // half = 3
      keyRemainingUsd: 25,
      reserveUsd: reserveUsd(0.6, 25), // 15 -> spendable 10
    });
    expect(r.budgetUsd).toBe(3);
    expect(r.bindingConstraint).toBe('credit_share');
  });
  it('is zero (not negative) when the key is below reserve', () => {
    const r = dailyDeepdiveBudget({ dailyCapUsd: 5, trailingCreditsUsd: 100, keyRemainingUsd: 10, reserveUsd: 15 });
    expect(r.budgetUsd).toBe(0);
    expect(r.bindingConstraint).toBe('zero');
  });
  it('runsAffordable divides by the per-run cap', () => {
    expect(runsAffordable(1.0, 0.2)).toBe(5);
    expect(runsAffordable(0.19, 0.2)).toBe(0);
  });
});

describe('deepdiveRunGate (M6 per-run hard gate)', () => {
  const IN = { capPerRunUsd: 0.2, dailyCapUsd: 5, todaySpendUsd: 1, spendableUsd: 30 };

  it('allows a run and caps its cost at the per-run limit', () => {
    const g = deepdiveRunGate(IN);
    expect(g).toMatchObject({ allowed: true, remainingTodayUsd: 4, maxRunCostUsd: 0.2 });
  });
  it('blocks when the daily cap is exhausted', () => {
    const g = deepdiveRunGate({ ...IN, todaySpendUsd: 5 });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/daily cap/);
  });
  it('blocks when the balance is at/below reserve', () => {
    expect(deepdiveRunGate({ ...IN, spendableUsd: 0 }).allowed).toBe(false);
    expect(deepdiveRunGate({ ...IN, spendableUsd: -1 }).reason).toMatch(/reserve/);
  });
  it('caps the run to the smallest of per-run / remaining-daily / spendable', () => {
    expect(deepdiveRunGate({ ...IN, todaySpendUsd: 4.95 }).maxRunCostUsd).toBe(0.05);
    expect(deepdiveRunGate({ ...IN, spendableUsd: 0.08 }).maxRunCostUsd).toBe(0.08);
  });
});

describe('unattended-lifecycle metric', () => {
  it('daysUnattended counts from the last manual action', () => {
    const then = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-06T00:00:00Z');
    expect(daysUnattended(then, now)).toBeCloseTo(5, 6);
    expect(daysUnattended(null)).toBe(0);
  });
  it('daysSinceLastManualAction picks the newest manual: entry', () => {
    const now = new Date('2026-09-06T00:00:00Z');
    const entries = [
      { reason: manualReason('claimed key in browser'), at: '2026-09-01T00:00:00Z' },
      { reason: 'status ok', at: '2026-09-05T00:00:00Z' },
      { reason: 'scheduled key rotation (hygiene)', at: '2026-09-05T12:00:00Z' },
    ];
    expect(daysSinceLastManualAction(entries, now)).toBeCloseTo(5, 6);
    expect(daysSinceLastManualAction([{ reason: 'status ok', at: '2026-09-05T00:00:00Z' }])).toBeNull();
  });
});

describe('token-store (AES-256-GCM)', () => {
  it('round-trips a token', () => {
    const key = loadEncryptionKey(generateEncryptionKey());
    const enc = encryptToken('sk-or-v1-secret', key);
    expect(enc).not.toContain('secret');
    expect(decryptToken(enc, key)).toBe('sk-or-v1-secret');
  });
  it('rejects a wrong key / tampered ciphertext', () => {
    const enc = encryptToken('tok', loadEncryptionKey(generateEncryptionKey()));
    expect(() => decryptToken(enc, loadEncryptionKey(generateEncryptionKey()))).toThrow();
  });
  it('validates the key length', () => {
    expect(() => loadEncryptionKey('c2hvcnQ=')).toThrow(/32 bytes/);
    expect(() => loadEncryptionKey(undefined)).toThrow();
  });
});

describe('lifecycle log chain', () => {
  const AGENT = `0x${'11'.repeat(32)}` as const;

  it('links entries by folding the previous bodyHash', async () => {
    const e1 = buildLifecycleEntry({ prevState: null, newState: 'NO_KEY', reason: 'instance start' });
    expect(e1.prevHash).toBe(GENESIS_HASH);
    const e2 = buildLifecycleEntry({ prevState: 'NO_KEY', newState: 'ACTIVE', reason: manualReason('claimed') }, e1.bodyHash);
    const e3 = buildLifecycleEntry({ prevState: 'ACTIVE', newState: 'DRAINING', reason: 'key remaining is low' }, e2.bodyHash);
    expect(verifyLifecycleChain([e1, e2, e3])).toBe(true);
  });

  it('detects a tampered entry', () => {
    const e1 = buildLifecycleEntry({ prevState: null, newState: 'NO_KEY', reason: 'a' });
    const e2 = buildLifecycleEntry({ prevState: 'NO_KEY', newState: 'ACTIVE', reason: 'b' }, e1.bodyHash);
    const tampered = { ...e2, reason: 'c' };
    expect(verifyLifecycleChain([e1, tampered])).toBe(false);
  });

  it('signs an entry with the agent key', async () => {
    const e = buildLifecycleEntry({ prevState: 'ACTIVE', newState: 'ROTATING', reason: 'hygiene' });
    const sig = await signLifecycleEntry(e.bodyHash, AGENT);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
