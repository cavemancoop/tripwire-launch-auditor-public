import { describe, expect, it } from 'vitest';
import { classifyPair } from '../src/watcher/classify';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TOKEN = '0xf630559b24d6d3186efa9fdf577dea6adb4b1337'; // ADAMARON, a real 4663 launch
const OTHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('classifyPair (chain 4663)', () => {
  it('picks the non-quote side when one side is USDG, confidently', () => {
    const a = classifyPair(4663, USDG, TOKEN);
    expect(a.token).toBe(TOKEN);
    expect(a.quote?.toLowerCase()).toBe(USDG.toLowerCase());
    expect(a.confident).toBe(true);
  });

  it('is order-independent', () => {
    const a = classifyPair(4663, TOKEN, USDG);
    expect(a.token).toBe(TOKEN);
    expect(a.confident).toBe(true);
  });

  it('is case-insensitive on the quote match', () => {
    expect(classifyPair(4663, USDG.toLowerCase(), TOKEN).confident).toBe(true);
  });

  it('treats the zero address (native ETH in v4) as the quote, confidently', () => {
    const a = classifyPair(4663, '0x0000000000000000000000000000000000000000', TOKEN);
    expect(a.token).toBe(TOKEN);
    expect(a.confident).toBe(true);
  });

  it('falls back to token1 with low confidence when neither side is a known quote', () => {
    const a = classifyPair(4663, OTHER, TOKEN);
    expect(a.token).toBe(TOKEN);
    expect(a.confident).toBe(false);
  });
});
