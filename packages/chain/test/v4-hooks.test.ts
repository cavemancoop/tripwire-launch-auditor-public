import { describe, expect, it } from 'vitest';
import { decodeHookPermissions, HOOK_FLAG, hookRisk } from '../src/v4-hooks';

/** build a hook address whose low bits carry `flags` */
const addrWithFlags = (flags: number): string =>
  `0x${flags.toString(16).padStart(40, '0')}`;

describe('decodeHookPermissions', () => {
  it('a zero / null address is a hookless pool', () => {
    for (const a of [null, undefined, '0x0000000000000000000000000000000000000000']) {
      const p = decodeHookPermissions(a);
      expect(p.hasHook).toBe(false);
      expect(p.flags).toBe(0);
      expect(Object.values(p.enabled).every((v) => v === false)).toBe(true);
    }
  });

  it('reads the enabled callbacks from the address low 14 bits', () => {
    const flags = HOOK_FLAG.beforeSwap | HOOK_FLAG.beforeSwapReturnsDelta;
    const p = decodeHookPermissions(addrWithFlags(flags));
    expect(p.hasHook).toBe(true);
    expect(p.flags).toBe(flags);
    expect(p.enabled.beforeSwap).toBe(true);
    expect(p.enabled.beforeSwapReturnsDelta).toBe(true);
    expect(p.enabled.afterSwap).toBe(false);
    expect(p.enabled.beforeRemoveLiquidity).toBe(false);
  });

  it('ignores bits above the 14-bit permission mask', () => {
    // high address bits set, permission bits = just beforeRemoveLiquidity
    const p = decodeHookPermissions(
      `0xdeadbeefdeadbeefdeadbeefdeadbeef${(HOOK_FLAG.beforeRemoveLiquidity).toString(16).padStart(8, '0')}`,
    );
    expect(p.enabled.beforeRemoveLiquidity).toBe(true);
    expect(p.enabled.beforeSwap).toBe(false);
  });
});

describe('hookRisk', () => {
  it('flags block / tax / lp-gate capability', () => {
    const block = hookRisk(decodeHookPermissions(addrWithFlags(HOOK_FLAG.beforeSwap)));
    expect(block).toMatchObject({ canBlockSwap: true, canTaxSwap: false, gatesLpRemoval: false });

    const tax = hookRisk(decodeHookPermissions(addrWithFlags(HOOK_FLAG.afterSwapReturnsDelta)));
    expect(tax.canTaxSwap).toBe(true);

    const gate = hookRisk(decodeHookPermissions(addrWithFlags(HOOK_FLAG.beforeRemoveLiquidity)));
    expect(gate.gatesLpRemoval).toBe(true);

    const clean = hookRisk(decodeHookPermissions(null));
    expect(clean).toMatchObject({ canBlockSwap: false, canTaxSwap: false, gatesLpRemoval: false });
  });
});
