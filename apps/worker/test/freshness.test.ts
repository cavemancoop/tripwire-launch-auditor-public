import { describe, expect, it } from 'vitest';
import {
  FRESH_LAUNCH_WINDOW_BLOCKS,
  checkTokenFreshness,
  computeTokenAgeAtPool,
} from '../src/watcher/freshness';

const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL_BLOCK = 2_000_000n; // > 24h window

function fakeClient(opts: { codeAtCheckBlock?: `0x${string}` | undefined; throws?: boolean }) {
  return {
    getCode: async () => {
      if (opts.throws) throw new Error('missing trie node');
      return opts.codeAtCheckBlock;
    },
  };
}

describe('checkTokenFreshness (24h window)', () => {
  it('window is ~24h of blocks', () => {
    expect(FRESH_LAUNCH_WINDOW_BLOCKS).toBe(864_000n);
  });

  it('is fresh when the token has no code at the window start', async () => {
    const r = await checkTokenFreshness(fakeClient({ codeAtCheckBlock: undefined }), TOKEN, POOL_BLOCK);
    expect(r.reason).toBe('fresh');
    expect(r.isFreshLaunch).toBe(true);
    expect(r.checkedAtBlock).toBe(POOL_BLOCK - FRESH_LAUNCH_WINDOW_BLOCKS);
  });

  it('is fresh on bare "0x"', async () => {
    const r = await checkTokenFreshness(fakeClient({ codeAtCheckBlock: '0x' }), TOKEN, POOL_BLOCK);
    expect(r.reason).toBe('fresh');
  });

  it('is preexisting when code already existed 24h before the pool', async () => {
    const r = await checkTokenFreshness(fakeClient({ codeAtCheckBlock: '0x6080' }), TOKEN, POOL_BLOCK);
    expect(r.reason).toBe('preexisting');
    expect(r.isFreshLaunch).toBe(false);
  });

  it('clamps the check block to 0 near genesis', async () => {
    const r = await checkTokenFreshness(fakeClient({ codeAtCheckBlock: undefined }), TOKEN, 10n);
    expect(r.checkedAtBlock).toBe(0n);
  });

  it('is inconclusive (defaults fresh) when the RPC cannot answer', async () => {
    const r = await checkTokenFreshness(fakeClient({ throws: true }), TOKEN, POOL_BLOCK);
    expect(r.reason).toBe('inconclusive');
    expect(r.isFreshLaunch).toBe(true);
  });
});

describe('computeTokenAgeAtPool', () => {
  // synthetic: token has code from `deployBlock` onward
  const client = (deployBlock: bigint) => ({
    getCode: async ({ blockNumber }: { blockNumber: bigint }) =>
      (blockNumber >= deployBlock ? '0x6080' : undefined) as `0x${string}` | undefined,
  });

  it('returns null when code predates the 24h window', async () => {
    const r = await computeTokenAgeAtPool(client(0n) as never, TOKEN, POOL_BLOCK, 0.1);
    expect(r.ageSec).toBeNull();
  });

  it('binary-searches the deployment block and converts to seconds', async () => {
    const deploy = POOL_BLOCK - 300_000n; // ~30k s at 0.1s/block
    const r = await computeTokenAgeAtPool(client(deploy) as never, TOKEN, POOL_BLOCK, 0.1);
    expect(r.ageSec).not.toBeNull();
    // within a few % of 30,000 s given the 12-iter cap
    expect(r.ageSec!).toBeGreaterThan(28_000);
    expect(r.ageSec!).toBeLessThan(32_000);
  });

  it('returns null on an RPC error', async () => {
    const boom = { getCode: async () => { throw new Error('archive gone'); } };
    const r = await computeTokenAgeAtPool(boom as never, TOKEN, POOL_BLOCK, 0.1);
    expect(r.ageSec).toBeNull();
  });
});
