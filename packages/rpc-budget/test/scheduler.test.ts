import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestScheduler } from '../src/scheduler';

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RequestScheduler — ordering', () => {
  it('runs jobs in priority order, FIFO within a tier', async () => {
    const s = new RequestScheduler({ rpm: 6_000_000, maxInFlight: 1 });
    const order: string[] = [];
    const mk = (tag: string) => () => {
      order.push(tag);
      return Promise.resolve(tag);
    };
    const done = Promise.all([
      s.schedule(4, mk('4a')),
      s.schedule(4, mk('4b')),
      s.schedule(0, mk('0a')),
      s.schedule(2, mk('2')),
      s.schedule(0, mk('0b')),
    ]);
    await done;
    expect(order).toEqual(['0a', '0b', '2', '4a', '4b']);
  });
});

describe('RequestScheduler — concurrency', () => {
  it('never exceeds maxInFlight and starts the next as slots free', async () => {
    const s = new RequestScheduler({ rpm: 6_000_000, maxInFlight: 2 });
    const resolvers: Array<() => void> = [];
    const make = () =>
      s.schedule(0, () => new Promise<void>((res) => resolvers.push(() => res())));

    const p1 = make();
    const p2 = make();
    const p3 = make();
    void p1;
    void p2;
    void p3;
    await flush();

    expect(s.stats.inFlight).toBe(2);
    expect(s.stats.started).toBe(2);

    resolvers[0]!();
    await flush();
    expect(s.stats.started).toBe(3);
    expect(s.stats.completed).toBe(1);

    resolvers[1]!();
    resolvers[2]!();
    await Promise.all([p1, p2, p3]);
    expect(s.stats.completed).toBe(3);
  });
});

describe('RequestScheduler — failures', () => {
  it('rejects the caller and keeps draining', async () => {
    const s = new RequestScheduler({ rpm: 6_000_000, maxInFlight: 1 });
    const bad = s.schedule(0, () => Promise.reject(new Error('boom')));
    const good = s.schedule(0, () => Promise.resolve('ok'));
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
    expect(s.stats.failed).toBe(1);
    expect(s.stats.completed).toBe(1);
  });
});

describe('RequestScheduler — rate limiting', () => {
  it('spreads execution at the token-bucket rate', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ rpm: 60, burst: 1, maxInFlight: 8 });
    const started: number[] = [];
    for (let i = 0; i < 3; i++) {
      void s.schedule(0, () => {
        started.push(i);
        return Promise.resolve();
      });
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(started.length).toBe(1); // burst of 1, then gated

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started.length).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started.length).toBe(3);
    expect(s.stats.completed).toBe(3);
  });
});
