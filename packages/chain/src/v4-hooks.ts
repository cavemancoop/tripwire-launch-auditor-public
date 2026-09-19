/**
 * Uniswap v4 encodes a hook's permissions in the low 14 bits of the hook
 * *address* — so which callbacks a hook can run is knowable with zero RPC, from
 * `Launch.poolHooks` alone. A hook is the new pre-staged-exit surface on chain
 * 4663: `beforeSwap` can revert (block sells) or, with a returns-delta flag,
 * skim value (a dynamic tax); `beforeRemoveLiquidity` can gate LP exit — all
 * without touching the token contract that old scanners check.
 *
 * Flag layout from Uniswap v4 `Hooks.sol`.
 */
export const HOOK_FLAG = {
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnsDelta: 1 << 3,
  afterSwapReturnsDelta: 1 << 2,
  afterAddLiquidityReturnsDelta: 1 << 1,
  afterRemoveLiquidityReturnsDelta: 1 << 0,
} as const;

export type HookFlagName = keyof typeof HOOK_FLAG;
const HOOK_MASK = 0x3fff; // low 14 bits

const ZERO = '0x0000000000000000000000000000000000000000';

export interface HookPermissions {
  hasHook: boolean;
  /** the 14-bit permission value */
  flags: number;
  enabled: Record<HookFlagName, boolean>;
}

export function decodeHookPermissions(hookAddress: string | null | undefined): HookPermissions {
  if (!hookAddress || hookAddress.toLowerCase() === ZERO) {
    return {
      hasHook: false,
      flags: 0,
      enabled: Object.fromEntries(
        (Object.keys(HOOK_FLAG) as HookFlagName[]).map((k) => [k, false]),
      ) as Record<HookFlagName, boolean>,
    };
  }
  const flags = Number(BigInt(hookAddress) & BigInt(HOOK_MASK));
  const enabled = Object.fromEntries(
    (Object.entries(HOOK_FLAG) as [HookFlagName, number][]).map(([k, bit]) => [k, (flags & bit) !== 0]),
  ) as Record<HookFlagName, boolean>;
  return { hasHook: true, flags, enabled };
}

export interface HookRisk {
  /** a beforeSwap hook can always revert -> block a sell */
  canBlockSwap: boolean;
  /** a returns-delta swap hook can skim output -> effective dynamic tax */
  canTaxSwap: boolean;
  /** a beforeRemoveLiquidity hook can gate LP exit (protective or restrictive) */
  gatesLpRemoval: boolean;
}

export function hookRisk(p: HookPermissions): HookRisk {
  return {
    canBlockSwap: p.enabled.beforeSwap,
    canTaxSwap: p.enabled.beforeSwapReturnsDelta || p.enabled.afterSwapReturnsDelta,
    gatesLpRemoval: p.enabled.beforeRemoveLiquidity,
  };
}
