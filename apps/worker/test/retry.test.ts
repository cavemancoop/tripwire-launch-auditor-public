import { describe, expect, it, vi } from 'vitest';
import { isTransientRpcError, withRetry } from '../src/watcher/retry';

class TransactionNotFoundError extends Error {
  override name = 'TransactionNotFoundError';
}

describe('isTransientRpcError', () => {
  it('recognises viem not-found errors by name', () => {
    expect(isTransientRpcError(new TransactionNotFoundError('nope'))).toBe(true);
  });
  it('recognises the message forms a lagging RPC returns', () => {
    expect(isTransientRpcError(new Error('Block at number "123" could not be found.'))).toBe(true);
    expect(isTransientRpcError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientRpcError(new Error('socket hang up'))).toBe(true);
  });
  it('does not treat a genuine bug as transient', () => {
    expect(isTransientRpcError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries a transient failure then resolves', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransactionNotFoundError('lag'))
      .mockResolvedValueOnce('ok');
    await expect(withRetry(fn, { tries: 3, delayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-transient failure without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('real bug'));
    await expect(withRetry(fn, { tries: 4, delayMs: 1 })).rejects.toThrow('real bug');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('gives up after exhausting tries', async () => {
    const fn = vi.fn().mockRejectedValue(new TransactionNotFoundError('still lagging'));
    await expect(withRetry(fn, { tries: 3, delayMs: 1 })).rejects.toThrow(/still lagging/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
