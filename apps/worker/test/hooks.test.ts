import { HOOK_FLAG } from '@launch-auditor/chain';
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_TOPIC0, addressToTopic } from '../src/watcher/erc20';
import {
  computeCreatorDrainerApprovals,
  computeHookFeatures,
  computeSidePoolCount,
  infraAddresses,
} from '../src/watcher/hooks';

const addr = (flags: number) => `0x${flags.toString(16).padStart(40, '0')}`;

describe('computeHookFeatures', () => {
  it('a hookless pool is clean', () => {
    expect(computeHookFeatures(null)).toEqual({
      hookPermissions: 0,
      hookCanBlockSwap: false,
      hookCanTaxSwap: false,
      hookGatesLpRemoval: false,
    });
  });

  it('derives block / tax / lp-gate from the hook address bits', () => {
    const f = computeHookFeatures(addr(HOOK_FLAG.beforeSwap | HOOK_FLAG.beforeSwapReturnsDelta));
    expect(f.hookCanBlockSwap).toBe(true);
    expect(f.hookCanTaxSwap).toBe(true);
    expect(f.hookGatesLpRemoval).toBe(false);
    expect(f.hookPermissions).toBe(HOOK_FLAG.beforeSwap | HOOK_FLAG.beforeSwapReturnsDelta);
  });
});

describe('infraAddresses', () => {
  it('includes the confirmed launchpad factories', () => {
    const s = infraAddresses(4663);
    expect(s.has('0x3711cea4feade896c913c68f01eda97cb06d1a42')).toBe(true); // Pons
    expect(s.has('0x1b37d3a72082029c44b35b604ea473617580b69a')).toBe(true); // LONG
    expect(s.has('0x8366a39cc670b4001a1121b8f6a443a643e40951')).toBe(true); // v4 PoolManager
  });
});

const POOL_ID = `0x${'11'.repeat(32)}`;
const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const DRAINER = '0x3333333333333333333333333333333333333333';

describe('computeSidePoolCount', () => {
  it('counts other v4 pools the token has a currency slot in, excluding the primary', async () => {
    const initTopic = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
    const client = {
      request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
        if (method !== 'eth_getLogs') throw new Error(method);
        const asC1 = params[0].topics.length >= 4;
        // primary + one side pool as currency0; one more as currency1
        if (asC1) return [{ topics: [initTopic, `0x${'aa'.repeat(32)}`] }];
        return [
          { topics: [initTopic, POOL_ID] },
          { topics: [initTopic, `0x${'bb'.repeat(32)}`] },
        ];
      }),
    };
    const n = await computeSidePoolCount(client as never, 4663, TOKEN, POOL_ID, 0n, 100n, 2000);
    expect(n).toBe(2); // bb + aa, primary excluded
  });
});

describe('computeCreatorDrainerApprovals', () => {
  it('counts distinct non-infra spenders the creator approved', async () => {
    const client = {
      request: vi.fn(async ({ method, params }: { method: string; params: any[] }) => {
        if (method !== 'eth_getLogs') throw new Error(method);
        expect(params[0].topics[0]).toBe(APPROVAL_TOPIC0);
        return [
          { topics: [APPROVAL_TOPIC0, addressToTopic(CREATOR), addressToTopic(DRAINER)], data: '0x', blockNumber: '0x1', logIndex: '0x0', transactionHash: '0xa' },
          { topics: [APPROVAL_TOPIC0, addressToTopic(CREATOR), addressToTopic(DRAINER)], data: '0x', blockNumber: '0x2', logIndex: '0x0', transactionHash: '0xb' },
          {
            topics: [
              APPROVAL_TOPIC0,
              addressToTopic(CREATOR),
              addressToTopic('0x8366a39cc670b4001a1121b8f6a443a643e40951'), // infra -> ignored
            ],
            data: '0x',
            blockNumber: '0x3',
            logIndex: '0x0',
            transactionHash: '0xc',
          },
        ];
      }),
    };
    const n = await computeCreatorDrainerApprovals(client as never, 4663, TOKEN, [CREATOR], 0n, 100n, 2000);
    expect(n).toBe(1);
  });

  it('is null with no owners', async () => {
    const client = { request: vi.fn() };
    expect(await computeCreatorDrainerApprovals(client as never, 4663, TOKEN, [], 0n, 100n, 2000)).toBeNull();
  });
});
