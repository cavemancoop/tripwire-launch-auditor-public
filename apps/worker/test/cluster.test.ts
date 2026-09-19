import { describe, expect, it, vi } from 'vitest';
import { buildCreatorCluster } from '../src/watcher/cluster';
import { TRANSFER_TOPIC0, addressToTopic } from '../src/watcher/erc20';

const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333'; // liquiditySource
const BUYER = '0x4444444444444444444444444444444444444444';
const SLEEPER = '0x5555555555555555555555555555555555555555';

function transferLog(from: string, to: string, tx: string) {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC0, addressToTopic(from), addressToTopic(to)],
    data: `0x${(10n ** 18n).toString(16).padStart(64, '0')}`,
    transactionHash: tx,
    blockNumber: '0x1',
  };
}

/** fake eth_getLogs: rule 2 filters from==POOL (single block), rule 3 filters from==CREATOR */
function fakeRequest() {
  return vi.fn(async ({ method, params }: { method: string; params: [{ topics: string[] }] }) => {
    if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
    const fromTopic = params[0].topics[1]?.toLowerCase();
    if (fromTopic === addressToTopic(POOL)) {
      return [transferLog(POOL, BUYER, '0xbuy1'), transferLog(POOL, CREATOR, '0xbuy2')];
    }
    if (fromTopic === addressToTopic(CREATOR)) {
      return [
        transferLog(CREATOR, SLEEPER, '0xsend1'),
        transferLog(CREATOR, POOL, '0xaddlp'), // adding LP — must NOT cluster
      ];
    }
    return [];
  });
}

describe('buildCreatorCluster (rules 1-3)', () => {
  it('always includes the creator via rule CREATOR', async () => {
    const c = await buildCreatorCluster({
      client: { request: fakeRequest() } as never,
      token: TOKEN,
      creator: CREATOR,
      liquiditySource: POOL,
      launchBlock: 100n,
      windowBlocks: 6000n,
      maxRange: 2000,
    });
    const creator = c.members.find((m) => m.rule === 'CREATOR');
    expect(creator?.address).toBe(CREATOR.toLowerCase());
    expect(creator?.evidenceTx).toBeNull();
    expect(creator?.confidence).toBe(1);
  });

  it('adds a launch-block buyer with its evidence tx, ignoring the creator self-buy', async () => {
    const c = await buildCreatorCluster({
      client: { request: fakeRequest() } as never,
      token: TOKEN,
      creator: CREATOR,
      liquiditySource: POOL,
      launchBlock: 100n,
      windowBlocks: 6000n,
      maxRange: 2000,
    });
    const buy = c.members.find((m) => m.rule === 'LAUNCH_BLOCK_BUY' && m.address === BUYER.toLowerCase());
    expect(buy?.evidenceTx).toBe('0xbuy1');
    // creator got a launch-block buy too, but is only listed once as CREATOR
    expect(c.members.filter((m) => m.address === CREATOR.toLowerCase())).toHaveLength(1);
  });

  it('adds a direct recipient of creator tokens but not the pool (LP add)', async () => {
    const c = await buildCreatorCluster({
      client: { request: fakeRequest() } as never,
      token: TOKEN,
      creator: CREATOR,
      liquiditySource: POOL,
      launchBlock: 100n,
      windowBlocks: 6000n,
      maxRange: 2000,
    });
    expect(c.members.some((m) => m.rule === 'DIRECT_TRANSFER' && m.address === SLEEPER.toLowerCase())).toBe(true);
    expect(c.members.some((m) => m.address === POOL.toLowerCase())).toBe(false);
  });

  it('reports distinct size and a bounded confidence', async () => {
    const c = await buildCreatorCluster({
      client: { request: fakeRequest() } as never,
      token: TOKEN,
      creator: CREATOR,
      liquiditySource: POOL,
      launchBlock: 100n,
      windowBlocks: 6000n,
      maxRange: 2000,
    });
    expect(c.size).toBe(3); // creator, buyer, sleeper
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });

  it('rule 4 stays a no-op with the default (unavailable) lookup', async () => {
    const c = await buildCreatorCluster({
      client: { request: fakeRequest() } as never,
      token: TOKEN,
      creator: CREATOR,
      liquiditySource: POOL,
      launchBlock: 100n,
      windowBlocks: 6000n,
      maxRange: 2000,
    });
    expect(c.members.some((m) => m.rule === 'FIRST_INBOUND')).toBe(false);
  });

  it('rule 4 fires when a FirstInboundLookup confirms the creator funded a wallet', async () => {
    const c = await buildCreatorCluster({
      client: { request: fakeRequest() } as never,
      token: TOKEN,
      creator: CREATOR,
      liquiditySource: POOL,
      launchBlock: 100n,
      windowBlocks: 6000n,
      maxRange: 2000,
      firstInbound: { firstFunder: async (a) => (a === SLEEPER.toLowerCase() ? CREATOR : null) },
    });
    expect(c.members.some((m) => m.rule === 'FIRST_INBOUND' && m.address === SLEEPER.toLowerCase())).toBe(true);
  });
});
