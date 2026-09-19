import { describe, expect, it } from 'vitest';
import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GENESIS_HASH, verifyLifecycleRows, type LifecycleChainRow } from '@launch-auditor/db';
import {
  decideLifecycle,
  HeadMovedError,
  LifecycleLogWriter,
  restrictToObserve,
  type LifecycleConfig,
  type LifecyclePersistRecord,
  type LifecycleReading,
} from '../src/metabolism/lifecycle-runner';
import type { IdsReconcile } from '../src/metabolism/ids-reconcile';
import { nextState } from '../src/metabolism/state';

const CFG: LifecycleConfig = {
  reserveUsd: 3,
  lowWaterUsd: 6,
  hygieneRotateDays: 7,
  idsToleranceUsd: 0.01,
  idsGraceUsd: 0.25,
};

const IDS_OK: IdsReconcile = {
  mismatch: false,
  direction: 'ok',
  providerDeltaUsd: 0,
  ledgerDeltaUsd: 0,
  excessUsd: 0,
  reason: 'ids ok',
};
const IDS_MISMATCH: IdsReconcile = {
  ...IDS_OK,
  mismatch: true,
  direction: 'provider_ahead',
  excessUsd: 1.5,
  reason: 'ids: gateway outpaced the ledger by $1.5000',
};

const base: LifecycleReading = {
  state: 'ACTIVE',
  halted: false,
  balanceUsd: 20,
  hasKey: true,
  holdSecret: true,
  keyAgeDays: 1,
  ledgerSpendUsd: 0,
  providerSpendUsd: 0,
  ids: IDS_OK,
};
const read = (over: Partial<LifecycleReading>): LifecycleReading => ({ ...base, ...over });

describe('decideLifecycle — adapted §8 machine (2026-09-09 decisions)', () => {
  it('NO_KEY + balance above reserve → mint → ACTIVE', () => {
    const d = decideLifecycle(read({ state: 'NO_KEY', hasKey: false, holdSecret: false }), CFG);
    expect(d).toMatchObject({ kind: 'transition', to: 'ACTIVE', event: 'KEY_CLAIMED', mint: true });
  });

  it('NO_KEY + balance at/below reserve → STARVED (no mint)', () => {
    const d = decideLifecycle(read({ state: 'NO_KEY', hasKey: false, balanceUsd: 3 }), CFG);
    expect(d).toMatchObject({ kind: 'transition', to: 'STARVED', event: 'NO_CREDITS' });
  });

  it('NO_KEY + halted → steady (awaits manual re-auth)', () => {
    const d = decideLifecycle(read({ state: 'NO_KEY', hasKey: false, halted: true }), CFG);
    expect(d).toEqual({ kind: 'steady', state: 'NO_KEY', reason: expect.stringContaining('halted') });
  });

  it('ACTIVE healthy → steady ACTIVE', () => {
    expect(decideLifecycle(read({}), CFG)).toMatchObject({ kind: 'steady', state: 'ACTIVE' });
  });

  it('ACTIVE + balance below low-water but above reserve → DRAINING', () => {
    const d = decideLifecycle(read({ balanceUsd: 5 }), CFG);
    expect(d).toMatchObject({ kind: 'transition', from: 'ACTIVE', to: 'DRAINING', event: 'LOW_BALANCE' });
  });

  it('DRAINING + balance back above low-water → ACTIVE', () => {
    const d = decideLifecycle(read({ state: 'DRAINING', balanceUsd: 12 }), CFG);
    expect(d).toMatchObject({ kind: 'transition', from: 'DRAINING', to: 'ACTIVE', event: 'STATUS_OK' });
  });

  it('DRAINING + still low → steady DRAINING', () => {
    expect(decideLifecycle(read({ state: 'DRAINING', balanceUsd: 5 }), CFG)).toMatchObject({
      kind: 'steady',
      state: 'DRAINING',
    });
  });

  it('ACTIVE + balance ≤ reserve → STARVED, never ROTATING (no drain-then-rotate)', () => {
    const d = decideLifecycle(read({ balanceUsd: 2.5 }), CFG);
    expect(d).toMatchObject({ kind: 'transition', to: 'STARVED', event: 'NO_CREDITS' });
  });

  it('ACTIVE + key age ≥ hygiene days → rotate', () => {
    const d = decideLifecycle(read({ keyAgeDays: 7.2 }), CFG);
    expect(d).toEqual({ kind: 'rotate', from: 'ACTIVE', reason: expect.stringContaining('hygiene') });
  });

  it('ACTIVE + key exists at provider but we do not hold the secret → revoke', () => {
    const d = decideLifecycle(read({ holdSecret: false }), CFG);
    expect(d).toMatchObject({ kind: 'revoke', from: 'ACTIVE' });
  });

  it('ACTIVE + provider reports no key → NO_KEY', () => {
    const d = decideLifecycle(read({ hasKey: false, holdSecret: false }), CFG);
    expect(d).toMatchObject({ kind: 'transition', from: 'ACTIVE', to: 'NO_KEY', event: 'REVOKED' });
  });

  // M5c: a ledger/provider gap is the estimator being wrong, not a compromised
  // key. It must never revoke — that was the 2026-09-12 near-failure.
  it('IDS mismatch no longer revokes — the key stays and the tick proceeds normally', () => {
    const d = decideLifecycle(read({ ids: IDS_MISMATCH }), CFG);
    expect(d.kind).toBe('steady');
    expect(d).toMatchObject({ state: 'ACTIVE' });
  });

  it('IDS mismatch does not even pre-empt a hygiene rotation', () => {
    const d = decideLifecycle(read({ keyAgeDays: 30, ids: IDS_MISMATCH }), CFG);
    expect(d.kind).toBe('rotate');
  });

  it('PHANTOM_SPEND revokes from any keyed state, pre-empting a hygiene-due key', () => {
    const d = decideLifecycle(read({ keyAgeDays: 30, phantomSpend: true }), CFG);
    expect(d).toMatchObject({ kind: 'revoke', from: 'ACTIVE' });
    expect((d as { reason: string }).reason).toMatch(/phantom/);
    expect(decideLifecycle(read({ state: 'DRAINING', balanceUsd: 5, phantomSpend: true }), CFG).kind).toBe('revoke');
    expect(decideLifecycle(read({ state: 'STARVED', balanceUsd: 1, phantomSpend: true }), CFG).kind).toBe('revoke');
  });

  it('PHANTOM_SPEND does NOT act from NO_KEY / REVOKING (nothing to revoke)', () => {
    expect(
      decideLifecycle(read({ state: 'NO_KEY', hasKey: false, holdSecret: false, phantomSpend: true }), CFG).kind,
    ).toBe('transition');
    expect(decideLifecycle(read({ state: 'REVOKING', phantomSpend: true }), CFG)).toMatchObject({
      kind: 'transition',
      to: 'NO_KEY',
    });
  });

  it('STARVED + balance recovers, key still valid → ACTIVE without minting', () => {
    const d = decideLifecycle(read({ state: 'STARVED', balanceUsd: 10 }), CFG);
    expect(d).toMatchObject({ kind: 'transition', to: 'ACTIVE', event: 'KEY_CLAIMED' });
    expect((d as { mint?: boolean }).mint).toBeUndefined();
  });

  it('STARVED + balance recovers, no key → mint → ACTIVE', () => {
    const d = decideLifecycle(read({ state: 'STARVED', balanceUsd: 10, hasKey: false, holdSecret: false }), CFG);
    expect(d).toMatchObject({ kind: 'transition', to: 'ACTIVE', mint: true });
  });

  it('STARVED + still below reserve → steady STARVED', () => {
    expect(decideLifecycle(read({ state: 'STARVED', balanceUsd: 1 }), CFG)).toMatchObject({
      kind: 'steady',
      state: 'STARVED',
    });
  });

  it('ROTATING resumes to ACTIVE with a mint', () => {
    expect(decideLifecycle(read({ state: 'ROTATING' }), CFG)).toMatchObject({
      kind: 'transition',
      to: 'ACTIVE',
      mint: true,
    });
  });

  it('REVOKING resumes to NO_KEY', () => {
    expect(decideLifecycle(read({ state: 'REVOKING' }), CFG)).toMatchObject({
      kind: 'transition',
      to: 'NO_KEY',
      event: 'REVOKED',
    });
  });
});

describe('restrictToObserve — a seeded container never mints, rotates or revokes', () => {
  const observe = (r: LifecycleReading) => restrictToObserve(decideLifecycle(r, CFG), r);

  it('NO_KEY with the operator key live at the provider → adopt it, no mint', () => {
    const d = observe(read({ state: 'NO_KEY', hasKey: true, holdSecret: true }));
    expect(d).toMatchObject({ kind: 'transition', to: 'ACTIVE', event: 'KEY_CLAIMED', mint: false });
    expect(nextState('NO_KEY', 'KEY_CLAIMED')?.state).toBe('ACTIVE');
  });

  it('NO_KEY with no usable key → steady, logs the mint it skipped', () => {
    const d = observe(read({ state: 'NO_KEY', hasKey: false, holdSecret: false }));
    expect(d).toMatchObject({ kind: 'steady', state: 'NO_KEY' });
    expect(d.reason).toMatch(/^would mint/);
  });

  it('hygiene-due key → steady, no rotate', () => {
    const d = observe(read({ keyAgeDays: 9 }));
    expect(d).toMatchObject({ kind: 'steady', state: 'ACTIVE' });
    expect(d.reason).toMatch(/^would rotate/);
  });

  it('PHANTOM_SPEND → steady, no revoke (the billing gate still closes)', () => {
    const d = observe(read({ phantomSpend: true }));
    expect(d).toMatchObject({ kind: 'steady', state: 'ACTIVE' });
    expect(d.reason).toMatch(/^would revoke: phantom spend/);
  });

  it('non-acting transitions pass through untouched', () => {
    const r = read({ balanceUsd: 2 });
    expect(observe(r)).toEqual(decideLifecycle(r, CFG));
  });
});

describe('every emitted (from,event,to) is a real edge of state.ts', () => {
  // the runner drives state.ts's machine; enumerate the readings that produce a
  // `transition` and assert nextState agrees. `REVOKED` from ACTIVE/DRAINING is
  // the one documented bypass (provider lost the key out-of-band).
  const readings: LifecycleReading[] = [
    read({ state: 'NO_KEY', hasKey: false, holdSecret: false }), // -> ACTIVE / KEY_CLAIMED
    read({ state: 'NO_KEY', hasKey: false, balanceUsd: 1 }), // -> STARVED / NO_CREDITS
    read({ balanceUsd: 5 }), // ACTIVE -> DRAINING / LOW_BALANCE
    read({ state: 'DRAINING', balanceUsd: 12 }), // -> ACTIVE / STATUS_OK
    read({ balanceUsd: 2 }), // ACTIVE -> STARVED / NO_CREDITS
    read({ state: 'DRAINING', balanceUsd: 2 }), // -> STARVED / NO_CREDITS
    read({ state: 'STARVED', balanceUsd: 10 }), // -> ACTIVE / KEY_CLAIMED
    read({ state: 'ROTATING' }), // -> ACTIVE / KEY_CLAIMED
    read({ state: 'REVOKING' }), // -> NO_KEY / REVOKED
  ];

  for (const r of readings) {
    const d = decideLifecycle(r, CFG);
    if (d.kind !== 'transition') continue;
    it(`${d.from} --${d.event}--> ${d.to}`, () => {
      expect(nextState(d.from, d.event)?.state).toBe(d.to);
    });
  }

  it('rotate expands to ACTIVE--HYGIENE_DUE-->ROTATING--KEY_CLAIMED-->ACTIVE', () => {
    expect(nextState('ACTIVE', 'HYGIENE_DUE')?.state).toBe('ROTATING');
    expect(nextState('ROTATING', 'KEY_CLAIMED')?.state).toBe('ACTIVE');
  });

  it('revoke expands to *--PHANTOM_SPEND-->REVOKING--REVOKED-->NO_KEY', () => {
    expect(nextState('ACTIVE', 'PHANTOM_SPEND')?.state).toBe('REVOKING');
    expect(nextState('REVOKING', 'REVOKED')?.state).toBe('NO_KEY');
  });
});

describe('LifecycleLogWriter — hash chain + agent signature', () => {
  const AGENT = `0x${'11'.repeat(32)}` as const;
  const agentAddr = privateKeyToAccount(AGENT).address;

  const toChainRow = (rec: LifecyclePersistRecord): LifecycleChainRow => ({
    at: rec.createdAt.toISOString(),
    prevState: rec.prevState,
    newState: rec.newState,
    reason: rec.reason,
    isSnapshot: rec.isSnapshot,
    keyHashPrefix: rec.keyHashPrefix,
    balanceUsd: rec.balanceUsd,
    keyRemainingUsd: rec.keyRemainingUsd,
    reserveUsd: rec.reserveUsd,
    ledgerSpendUsd: rec.ledgerSpendUsd,
    providerSpendUsd: rec.providerSpendUsd,
    idsMismatch: rec.idsMismatch,
    prevHash: rec.prevHash,
    bodyHash: rec.bodyHash,
  });

  async function writeChain(seed = GENESIS_HASH) {
    const recs: LifecyclePersistRecord[] = [];
    const writer = new LifecycleLogWriter(AGENT, seed, async (rec) => {
      recs.push(rec);
      return { id: String(recs.length) };
    });
    await writer.append({ isSnapshot: false, prevState: null, newState: 'NO_KEY', reason: 'instance start', balanceUsd: 20, reserveUsd: 3 });
    await writer.append({ isSnapshot: false, prevState: 'NO_KEY', newState: 'ACTIVE', reason: 'minted key', balanceUsd: 20, reserveUsd: 3, keyHashPrefix: 'sk-orbio-AAA' });
    await writer.append({ isSnapshot: true, prevState: 'ACTIVE', newState: 'ACTIVE', reason: 'snapshot after → ACTIVE', balanceUsd: 20, reserveUsd: 3 });
    return { recs, writer };
  }

  it('links every row and verifies from genesis', async () => {
    const { recs, writer } = await writeChain();
    const rows = recs.map(toChainRow);
    const check = verifyLifecycleRows(rows);
    expect(check).toMatchObject({ linked: true, startsAtGenesis: true, length: 3, brokenAt: null });
    expect(writer.head).toBe(rows[2]!.bodyHash);
    expect(recs[0]!.prevHash).toBe(GENESIS_HASH);
    expect(recs[1]!.prevHash).toBe(recs[0]!.bodyHash);
  });

  it('each signature recovers to the agent address', async () => {
    const { recs } = await writeChain();
    for (const rec of recs) {
      const signer = await recoverMessageAddress({
        message: { raw: rec.bodyHash as `0x${string}` },
        signature: rec.signature as `0x${string}`,
      });
      expect(signer).toBe(agentAddr);
    }
  });

  it('detects a tampered row', async () => {
    const { recs } = await writeChain();
    const rows = recs.map(toChainRow);
    rows[1] = { ...rows[1]!, reason: 'tampered' };
    const check = verifyLifecycleRows(rows);
    expect(check.linked).toBe(false);
    expect(check.brokenAt).toBe(1);
  });

  // 2026-09-19: during a deploy the old and new worker both appended onto row
  // 229, forking the chain; the dashboard read "BROKEN" though no row changed.
  it('reports a fork — two signed rows sharing a parent — as intact, not broken', async () => {
    const { recs } = await writeChain();
    const rows = recs.map(toChainRow);
    // a second writer that also saw row 0 as the head
    const other: LifecyclePersistRecord[] = [];
    const w2 = new LifecycleLogWriter(AGENT, rows[0]!.bodyHash as `0x${string}`, async (rec) => {
      other.push(rec);
      return { id: 'x' };
    });
    await w2.append({ isSnapshot: true, prevState: 'NO_KEY', newState: 'NO_KEY', reason: 'second writer', balanceUsd: 20, reserveUsd: 3 });
    const forked = [rows[0]!, rows[1]!, toChainRow(other[0]!), rows[2]!];
    const check = verifyLifecycleRows(forked);
    expect(check.intact).toBe(true);
    expect(check.linked).toBe(false);
    expect(check.forks).toEqual([2, 3]);
    expect(check.brokenAt).toBeNull();
  });

  it('still reports a break when a row links to a parent that does not exist', async () => {
    const { recs } = await writeChain();
    const rows = recs.map(toChainRow);
    const gapped = [rows[0]!, rows[2]!]; // row 1 deleted: row 2's parent is missing
    const check = verifyLifecycleRows(gapped);
    expect(check.intact).toBe(false);
    expect(check.brokenAt).toBe(1);
  });

  it('re-chains onto the real head when another writer appended first', async () => {
    const recs: LifecyclePersistRecord[] = [];
    const realHead = `0x${'cd'.repeat(32)}` as const;
    let first = true;
    const writer = new LifecycleLogWriter(AGENT, GENESIS_HASH, async (rec) => {
      if (first) {
        first = false;
        throw new HeadMovedError(realHead);
      }
      recs.push(rec);
      return { id: '1' };
    });
    await writer.append({ isSnapshot: true, prevState: 'ACTIVE', newState: 'ACTIVE', reason: 'tick', balanceUsd: 20, reserveUsd: 3 });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.prevHash).toBe(realHead);
    expect(writer.head).toBe(recs[0]!.bodyHash);
    expect(verifyLifecycleRows(recs.map(toChainRow)).brokenAt).toBeNull();
  });

  it('a window that does not start at genesis still links internally', async () => {
    const seed = `0x${'ab'.repeat(32)}` as const;
    const { recs } = await writeChain(seed);
    const check = verifyLifecycleRows(recs.map(toChainRow));
    expect(check.linked).toBe(true);
    expect(check.startsAtGenesis).toBe(false);
  });
});
