import { describe, expect, it } from 'vitest';
import { pad, parseUnits, recoverMessageAddress, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  activatedTodayUsd,
  activationDecision,
  assertAllowedCall,
  deriveOrbioApiKey,
  describeKey,
  estimateBlockAt,
  orbioKeyMessage,
  trailingCreditsUsd,
  type ActivationInputs,
} from '../src/metabolism/credit-wallet';

// Anvil/Hardhat default account #1 — a public, well-known test key, not a project secret.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const ADDR = {
  credit: '0xe33322da1380e61e5ae5dfb21e7f62924c73004c',
  staking: '0xe0710011278bfb63e57c5f227e5980984b1eddca',
} as const;

describe('deriveOrbioApiKey — the wallet signature is the key', () => {
  it('matches the documented format and recovers to the wallet', async () => {
    const key = await deriveOrbioApiKey(PK, 0);
    expect(key).toMatch(/^sk-orb-0-[A-Za-z0-9+/]{87}=$/);
    expect(key.length).toBe(97); // same length as the live gas-wallet key
    const sig = `0x${Buffer.from(key.slice('sk-orb-0-'.length), 'base64').toString('hex')}` as const;
    expect(await recoverMessageAddress({ message: orbioKeyMessage(0), signature: sig })).toBe(privateKeyToAccount(PK).address);
  });

  it('is deterministic per epoch and changes on rotation', async () => {
    expect(await deriveOrbioApiKey(PK, 0)).toBe(await deriveOrbioApiKey(PK, 0));
    const rotated = await deriveOrbioApiKey(PK, 1);
    expect(rotated.startsWith('sk-orb-1-')).toBe(true);
    expect(rotated).not.toBe(await deriveOrbioApiKey(PK, 0));
  });

  it('logs never contain a usable key', async () => {
    const key = await deriveOrbioApiKey(PK, 0);
    const shown = describeKey(key);
    expect(shown).toMatch(/^sk-orb-0-.{4}… \(97 chars\)$/);
    expect(shown.length).toBeLessThan(30);
  });
});

describe('assertAllowedCall — the agent wallet cannot move tokens', () => {
  it('allows only CREDIT.activate and Staking.claim', () => {
    expect(() => assertAllowedCall(ADDR.credit, 'activate', ADDR)).not.toThrow();
    expect(() => assertAllowedCall(ADDR.staking.toUpperCase().replace('0X', '0x'), 'claim', ADDR)).not.toThrow();
  });

  it.each([
    [ADDR.credit, 'transfer'],
    [ADDR.credit, 'approve'],
    [ADDR.credit, 'transferFrom'],
    [ADDR.staking, 'unstake'],
    [ADDR.staking, 'unstakeAll'],
    [ADDR.staking, 'activate'],
    ['0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3', 'transfer'], // ORBIO
    ['0x6951ffd32630b05e06f50062aea801625a58ebc0', 'buy'], // Exchange
  ])('refuses %s.%s', (to, fn) => {
    expect(() => assertAllowedCall(to, fn, ADDR)).toThrow(/may only call CREDIT.activate and Staking.claim/);
  });

  it('refuses claim when no staking address is configured', () => {
    expect(() => assertAllowedCall(ADDR.staking, 'claim', { credit: ADDR.credit })).toThrow();
  });
});

describe('activationDecision', () => {
  const base: ActivationInputs = {
    apiBalanceUsd: 0,
    creditHeldUsd: 20,
    lowWaterUsd: 2,
    chunkUsd: 5,
    activatedTodayUsd: 0,
    dailyCapUsd: 5,
    pending: false,
    msSinceLastActivation: 0, // "just activated" — not stale, isolates the low-balance trigger in these tests
  };
  const d = (over: Partial<ActivationInputs>) => activationDecision({ ...base, ...over });

  it('activates one chunk when below low-water with CREDIT held', () => {
    expect(d({})).toMatchObject({ activate: true, amountUsd: 5 });
  });
  it('never more than what is held', () => {
    expect(d({ creditHeldUsd: 1.2345678 })).toMatchObject({ activate: true, amountUsd: 1.234567 });
  });
  it('never more than the rest of the daily cap', () => {
    expect(d({ activatedTodayUsd: 3.5 })).toMatchObject({ activate: true, amountUsd: 1.5 });
    expect(d({ activatedTodayUsd: 5 })).toMatchObject({ activate: false });
  });
  it('waits while a previous activation is pending', () => {
    expect(d({ pending: true })).toMatchObject({ activate: false });
  });
  it('does nothing above low-water or with no CREDIT', () => {
    expect(d({ apiBalanceUsd: 2 })).toMatchObject({ activate: false });
    expect(d({ creditHeldUsd: 0 })).toMatchObject({ activate: false });
  });
});

// 2026-09-16: property 2's daily budget is min(cap, 50% of trailing-24h
// accrual, balance). If accrual hits $0 the whole budget is $0 even with real
// balance left — spending stops, so balance stops moving, so the low-balance
// trigger above can never fire again. A time-based trigger is the only thing
// that can break that deadlock once it happens.
describe('activationDecision — keep-warm (deadlock prevention)', () => {
  const base: ActivationInputs = {
    apiBalanceUsd: 15, // healthy — would never trigger on balance alone
    creditHeldUsd: 20,
    lowWaterUsd: 2,
    chunkUsd: 5,
    activatedTodayUsd: 0,
    dailyCapUsd: 5,
    pending: false,
    msSinceLastActivation: 0,
  };
  const d = (over: Partial<ActivationInputs>) => activationDecision({ ...base, ...over });
  const HOUR = 3_600_000;

  it('does not activate on a healthy balance well within the keep-warm window', () => {
    expect(d({ msSinceLastActivation: 5 * HOUR })).toMatchObject({ activate: false });
  });

  it('activates anyway once the keep-warm window is reached, despite a healthy balance', () => {
    const r = d({ msSinceLastActivation: 20 * HOUR });
    expect(r).toMatchObject({ activate: true, amountUsd: 5 });
    expect(r.activate && r.reason).toMatch(/keep-warm/);
  });

  it('never activated before (null) is treated as maximally stale', () => {
    expect(d({ msSinceLastActivation: null })).toMatchObject({ activate: true, amountUsd: 5 });
  });

  it('a custom keep-warm window is honored', () => {
    expect(d({ msSinceLastActivation: 10 * HOUR, keepWarmAfterMs: 8 * HOUR })).toMatchObject({ activate: true });
    expect(d({ msSinceLastActivation: 6 * HOUR, keepWarmAfterMs: 8 * HOUR })).toMatchObject({ activate: false });
  });

  it('still refuses with no CREDIT held, even if maximally stale', () => {
    expect(d({ msSinceLastActivation: null, creditHeldUsd: 0 })).toMatchObject({ activate: false });
  });

  it('still respects the daily activation cap on a keep-warm trigger', () => {
    expect(d({ msSinceLastActivation: 20 * HOUR, activatedTodayUsd: 5 })).toMatchObject({ activate: false });
  });

  it('pending still wins over a stale window', () => {
    expect(d({ msSinceLastActivation: 20 * HOUR, pending: true })).toMatchObject({ activate: false });
  });
});

describe('estimateBlockAt', () => {
  const head = { number: 1_000_000n, timestamp: 1_000_000n };
  const ref = { number: 990_000n, timestamp: 995_000n }; // 2 blocks/sec
  it('interpolates backwards and never lands after the target', () => {
    const b = estimateBlockAt(900_000, head, ref);
    expect(b).toBeLessThanOrEqual(1_000_000n - 200_000n);
    expect(b).toBeGreaterThan(1_000_000n - 210_000n);
  });
  it('returns head for a target in the future', () => {
    expect(estimateBlockAt(2_000_000, head, ref)).toBe(1_000_000n);
  });
});

// 2026-09-16: property 2 reads Activated events directly. beneficiary is
// indexed as bytes32 (the address left-padded), not address — getting this
// wrong means the filter silently matches nothing and the daily budget always
// reads as $0 accrued, closing the deep-dive gate for no visible reason.
describe('trailingCreditsUsd / activatedTodayUsd — Activated event scans', () => {
  const AGENT = '0x9b4EDe199198ca3D41A9a7D2997606BaCd30BA03' as const;
  const OPERATOR = '0x4cb72456e82aeDd8b1ef0F08D03Cc6bFf96c6291' as const;

  function fakeClient(logsByBeneficiary: Record<string, { from: string; amount: bigint }[]>) {
    const calls: Array<{ args: unknown; fromBlock: bigint; toBlock: bigint }> = [];
    const HEAD = 2_000_000n;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const client = {
      // 1 block/sec, so estimateBlockAt's interpolation from these two points
      // lands trailingCreditsUsd's real (Date.now()-based) 24h target correctly.
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
        const number = blockNumber ?? HEAD;
        return { number, timestamp: nowSec - (HEAD - number) };
      },
      getContractEvents: async ({ args, fromBlock, toBlock }: { args: { from?: string; beneficiary?: string }; fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ args, fromBlock, toBlock });
        const key = args.beneficiary ?? args.from ?? '';
        const rows = logsByBeneficiary[key] ?? [];
        return rows
          .filter((r) => !args.from || r.from.toLowerCase() === args.from.toLowerCase())
          .map((r) => ({ args: { amount: r.amount } }));
      },
    } as unknown as PublicClient;
    return { client, calls };
  }

  it('filters by the padded bytes32 beneficiary, not the raw address', async () => {
    const paddedAgent = pad(AGENT.toLowerCase() as `0x${string}`, { size: 32 });
    const { client, calls } = fakeClient({
      [paddedAgent]: [
        { from: OPERATOR, amount: parseUnits('20', 6) },
        { from: AGENT, amount: parseUnits('5', 6) },
      ],
    });
    // a maxRange spanning the whole scan keeps this test to one chunk, so the
    // fake's per-chunk log list (it doesn't itself filter by block range) isn't double-counted
    const total = await trailingCreditsUsd(client, '0xe33322da1380e61e5ae5dfb21e7f62924c73004c', AGENT, 999_999_999n);
    expect(total).toBe(25);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ beneficiary: paddedAgent });
  });

  it('activatedTodayUsd filters by the plain from address (not the beneficiary)', async () => {
    const { client, calls } = fakeClient({
      [AGENT]: [
        { from: AGENT, amount: parseUnits('3', 6) },
        { from: OPERATOR, amount: parseUnits('100', 6) }, // would inflate the total if the filter leaked
      ],
    });
    const total = await activatedTodayUsd(client, '0xe33322da1380e61e5ae5dfb21e7f62924c73004c', AGENT, 999_999_999n);
    expect(total).toBe(3);
    expect(calls[0]!.args).toEqual({ from: AGENT });
  });

  it('chunks the scan at maxRange and sums across chunks', async () => {
    const paddedAgent = pad(AGENT.toLowerCase() as `0x${string}`, { size: 32 });
    const { client, calls } = fakeClient({ [paddedAgent]: [{ from: OPERATOR, amount: parseUnits('1', 6) }] });
    await trailingCreditsUsd(client, '0xe33322da1380e61e5ae5dfb21e7f62924c73004c', AGENT, 100n);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.toBlock - c.fromBlock).toBeLessThan(100n);
  });

  it('a 24h window with no accrual returns 0, not an error', async () => {
    const { client } = fakeClient({});
    expect(await trailingCreditsUsd(client, '0xe33322da1380e61e5ae5dfb21e7f62924c73004c', AGENT, 9_999n)).toBe(0);
  });
});
