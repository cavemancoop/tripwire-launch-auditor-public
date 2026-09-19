import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/token-bucket';

describe('TokenBucket', () => {
  const makeClock = (start = 0) => {
    const box = { t: start };
    return { now: () => box.t, advance: (ms: number) => (box.t += ms) };
  };

  it('starts full and drains one token per take', () => {
    const c = makeClock();
    const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: c.now });
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });

  it('refills at refillPerSec up to capacity', () => {
    const c = makeClock();
    const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: c.now });
    b.tryTake();
    b.tryTake();
    c.advance(1000);
    expect(b.available).toBeCloseTo(1, 5);
    expect(b.tryTake()).toBe(true);
    c.advance(10_000);
    expect(b.available).toBe(2); // capped at capacity
  });

  it('reports ms until the next token', () => {
    const c = makeClock();
    const b = new TokenBucket({ capacity: 1, refillPerSec: 2, now: c.now });
    expect(b.msUntilAvailable()).toBe(0);
    b.tryTake();
    expect(b.msUntilAvailable()).toBe(500); // 1 token / 2 per sec
    c.advance(250);
    expect(b.msUntilAvailable()).toBe(250);
  });

  it('rejects nonsensical options', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSec: 0 })).toThrow();
  });
});
