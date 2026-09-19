import { describe, expect, it } from 'vitest';
import { UNCONFIRMED_MAX_AGE_MS, unconfirmedAction } from '../src/commit/job';

// 2026-09-15: receipts missed the 240s deadline for txs that had mined, and the
// batch was re-committed. A sent tx is now resolved before any new batch goes out.
describe('unconfirmedAction', () => {
  const sentAt = 1_000_000;

  it('late success receipt → record that batch, do not re-commit', () => {
    expect(unconfirmedAction({ sentAt }, { status: 'success' }, sentAt + 400_000)).toBe('finalize');
  });

  it('reverted → drop, its reports re-commit', () => {
    expect(unconfirmedAction({ sentAt }, { status: 'reverted' }, sentAt + 1)).toBe('drop_reverted');
  });

  it('still no receipt → wait, send nothing', () => {
    expect(unconfirmedAction({ sentAt }, null, sentAt + UNCONFIRMED_MAX_AGE_MS - 1)).toBe('wait');
  });

  it('no receipt after the max age → drop', () => {
    expect(unconfirmedAction({ sentAt }, null, sentAt + UNCONFIRMED_MAX_AGE_MS)).toBe('drop_expired');
  });
});
