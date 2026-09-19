import { describe, expect, it } from 'vitest';
import { isOverQuota } from '../src/watcher/quota';

describe('isOverQuota (spec §3.1, limit 5 / 24h)', () => {
  it('lets the first five through', () => {
    expect(isOverQuota(0, 5)).toBe(false);
    expect(isOverQuota(4, 5)).toBe(false);
  });
  it('flags the sixth and beyond', () => {
    expect(isOverQuota(5, 5)).toBe(true);
    expect(isOverQuota(9, 5)).toBe(true);
  });
});
