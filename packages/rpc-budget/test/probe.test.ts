import { describe, expect, it } from 'vitest';
import { probeGetLogsRange } from '../src/probe';

const anchor = 1_000_000n;

describe('probeGetLogsRange', () => {
  it('returns the largest span the RPC accepts', async () => {
    const seen: number[] = [];
    const request = async ({ params }: { method: string; params: unknown[] }) => {
      const p = params[0] as { fromBlock: string; toBlock: string };
      const span = Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1;
      seen.push(span);
      if (span > 5_000) throw new Error('requested too many blocks: max block range is 10000');
      return [];
    };
    const got = await probeGetLogsRange(request, { address: '0xpm', anchorBlock: anchor });
    expect(got).toBe(5_000);
    expect(seen[0]).toBe(20_000); // tried largest first
  });

  it('takes the top candidate when everything is accepted', async () => {
    const request = async () => [];
    expect(await probeGetLogsRange(request, { address: '0xpm', anchorBlock: anchor })).toBe(20_000);
  });

  it('forwards a topic filter into the eth_getLogs params', async () => {
    let seenTopics: unknown;
    const request = async ({ params }: { method: string; params: unknown[] }) => {
      seenTopics = (params[0] as { topics?: unknown }).topics;
      return [];
    };
    await probeGetLogsRange(request, {
      address: '0xpm',
      anchorBlock: anchor,
      topics: ['0xdead'],
      candidates: [1_000],
    });
    expect(seenTopics).toEqual(['0xdead']);
  });

  it('falls back to the smallest candidate when every span errors', async () => {
    const request = async () => {
      throw new Error('some non-range failure');
    };
    expect(await probeGetLogsRange(request, { address: '0xpm', anchorBlock: anchor })).toBe(1_000);
  });

  it('honours custom candidates', async () => {
    const request = async ({ params }: { method: string; params: unknown[] }) => {
      const p = params[0] as { fromBlock: string; toBlock: string };
      const span = Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1;
      if (span > 3_000) throw new Error('block range too large');
      return [];
    };
    const got = await probeGetLogsRange(request, {
      address: '0xpm',
      anchorBlock: anchor,
      candidates: [8_000, 3_000, 500],
    });
    expect(got).toBe(3_000);
  });
});
