import { describe, expect, it, vi } from 'vitest';
import { getLogsByTopicValues } from '../src/logs';

const T0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const topic = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

describe('getLogsByTopicValues', () => {
  it('splits a large OR-list into batches of maxTopicValues and merges', async () => {
    const seenBatches: unknown[] = [];
    const client = {
      request: vi.fn(async ({ params }: { method: string; params: any[] }) => {
        const p = params[0];
        seenBatches.push(p.topics);
        // one log per value in this batch, block derived from the value (unique)
        const vals = p.topics[1] as string[];
        return vals.map((v) => ({
          address: '0xtok',
          topics: [T0, v, topic(999)],
          data: '0x',
          blockNumber: `0x${(10 + (parseInt(v.slice(-4), 16) % 900)).toString(16)}`,
          logIndex: '0x0',
          transactionHash: '0xabc',
        }));
      }),
    };

    const values = Array.from({ length: 10 }, (_, i) => topic(i + 1));
    const logs = await getLogsByTopicValues(client as never, {
      address: '0xtok',
      topic0: T0,
      valuePosition: 1,
      values,
      fromBlock: 0n,
      toBlock: 100n,
      maxRange: 5000,
      maxTopicValues: 4,
    });

    // 10 values / 4 per batch => 3 batches
    expect(seenBatches).toHaveLength(3);
    expect((seenBatches[0] as unknown[])).toHaveLength(2); // [topic0, [values]]
    expect(logs.length).toBe(10);
  });

  it('de-dups by (block, logIndex) and orders by block', async () => {
    const client = {
      request: vi.fn(async () => [
        { address: '0xt', topics: [T0], data: '0x', blockNumber: '0x14', logIndex: '0x1', transactionHash: '0x1' },
        { address: '0xt', topics: [T0], data: '0x', blockNumber: '0x0a', logIndex: '0x0', transactionHash: '0x2' },
        { address: '0xt', topics: [T0], data: '0x', blockNumber: '0x14', logIndex: '0x1', transactionHash: '0x1' }, // dup
      ]),
    };
    const logs = await getLogsByTopicValues(client as never, {
      topic0: T0,
      valuePosition: 2,
      values: [topic(1)],
      fromBlock: 0n,
      toBlock: 50n,
      maxRange: 5000,
    });
    expect(logs.map((l) => Number(l.blockNumber))).toEqual([10, 20]);
  });

  it('returns [] for an empty value list', async () => {
    const client = { request: vi.fn() };
    expect(
      await getLogsByTopicValues(client as never, {
        topic0: T0,
        valuePosition: 1,
        values: [],
        fromBlock: 0n,
        toBlock: 1n,
        maxRange: 100,
      }),
    ).toEqual([]);
    expect(client.request).not.toHaveBeenCalled();
  });
});
