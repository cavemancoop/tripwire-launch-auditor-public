import { describe, expect, it } from 'vitest';
import { DEFAULT_GIVE_UP_AFTER_MS, deferOrGiveUp, interleave } from '../src/outcomes/loop';

// 2026-09-15: 24 of every 25 sweep slots went to the same SELL_IMPAIRED@1h rows,
// deferred on an RPC error and re-picked next minute, so nine of eleven cells
// never filled. These pin the two rules that stop one label starving the rest.

describe('interleave — one label cannot take every slot', () => {
  it('round-robins across labels, oldest-first within each', () => {
    const sell = ['s1', 's2', 's3', 's4', 's5'];
    const insider = ['i1', 'i2'];
    const drawdown = ['d1'];
    expect(interleave([sell, insider, drawdown], 6)).toEqual(['s1', 'i1', 'd1', 's2', 'i2', 's3']);
  });

  it('fills remaining slots from whichever labels still have rows', () => {
    expect(interleave([['a1', 'a2', 'a3'], []], 3)).toEqual(['a1', 'a2', 'a3']);
  });

  it('stops when every queue is exhausted', () => {
    expect(interleave([['a1'], ['b1']], 25)).toEqual(['a1', 'b1']);
    expect(interleave([[], []], 25)).toEqual([]);
  });
});

describe('deferOrGiveUp — transient failures end as unresolvable, not forever', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');

  it('first deferral starts the clock and defers', () => {
    expect(deferOrGiveUp(undefined, now)).toEqual({ action: 'defer', firstDeferredAt: '2026-09-15T12:00:00.000Z' });
  });

  it('keeps the original clock on later deferrals', () => {
    const first = '2026-09-15T01:00:00.000Z';
    expect(deferOrGiveUp(first, now)).toEqual({ action: 'defer', firstDeferredAt: first });
  });

  it('gives up once the give-up window since the FIRST deferral has passed', () => {
    const first = new Date(now - DEFAULT_GIVE_UP_AFTER_MS).toISOString();
    expect(deferOrGiveUp(first, now).action).toBe('give_up');
  });

  it('a corrupt clock restarts instead of giving up immediately', () => {
    expect(deferOrGiveUp('not a date', now).action).toBe('defer');
  });
});
