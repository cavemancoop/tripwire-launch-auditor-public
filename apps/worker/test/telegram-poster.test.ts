import { describe, expect, it, vi } from 'vitest';
import {
  MIN_PEERS,
  formatTelegramMessage,
  isFresh,
  postQualifiedLaunches,
  rankTier,
  type PeerScores,
  type TelegramCandidateRow,
} from '../src/telegram/poster';

const ANCHOR = new Date('2026-09-18T12:10:00Z');
const minutesAfter = (m: number): Date => new Date(ANCHOR.getTime() + m * 60_000);

const ROW: TelegramCandidateRow = {
  id: 'r1',
  tokenAddress: '0xabc0000000000000000000000000000000000d',
  reportHash: `0x${'11'.repeat(32)}`,
  reportTime: ANCHOR,
  pInsiderExit24h: 0.9972,
  pTradingAlive24h: 0.0155,
  txHash: '0xdeadbeef',
  committedAt: minutesAfter(7),
};

/** 100 peers spread evenly over [0, 1): a value of x outranks ~x of them. */
const spread = (n = 100): number[] => Array.from({ length: n }, (_, i) => i / n);
const PEERS: PeerScores = { insiderExit24h: spread(), tradingAlive24h: spread() };

describe('rankTier', () => {
  it('buckets by the share of peers the value scores above', () => {
    expect(rankTier(0.95, spread())).toBe('top10');
    expect(rankTier(0.8, spread())).toBe('top25');
    expect(rankTier(0.5, spread())).toBe('middle');
    expect(rankTier(0.1, spread())).toBe('bottom25');
  });

  it('counts ties as half, so a launch tied with every peer lands in the middle', () => {
    expect(rankTier(0.99, Array(50).fill(0.99))).toBe('middle');
  });

  it('refuses to rank against too few peers, or a missing score', () => {
    expect(rankTier(0.9, spread(MIN_PEERS - 1))).toBeNull();
    expect(rankTier(null, spread())).toBeNull();
  });
});

describe('formatTelegramMessage', () => {
  it('posts rank tiers for insider exit and still trading — never a probability, never drawdown', () => {
    const msg = formatTelegramMessage(ROW, PEERS, 4663);
    expect(msg).toContain(ROW.tokenAddress);
    expect(msg).toContain('Insider exit within 24h: top 10% riskiest');
    expect(msg).toContain('Still trading at 24h: bottom 25% (least likely)');
    expect(msg).toContain('Ranked against the 100 qualified launches in the previous 24h.');
    expect(msg).not.toMatch(/:\s*\d+(\.\d+)?%/); // no "label: 42%" probability lines
    expect(msg).not.toMatch(/drawdown/i);
    expect(msg).not.toContain('P(');
  });

  it('carries the calibration footer, linking the benchmark when an api base is set', () => {
    expect(formatTelegramMessage(ROW, PEERS, 4663)).toContain(
      'Ranking only: these scores are not calibrated probabilities. Benchmark: see the dashboard',
    );
    expect(formatTelegramMessage(ROW, PEERS, 4663, 'https://api.example.test/')).toContain(
      'Benchmark: https://api.example.test/v1/benchmark',
    );
  });

  it('says it is not ranked when there are too few peers, instead of a coarse tier', () => {
    const few: PeerScores = { insiderExit24h: spread(5), tradingAlive24h: spread(5) };
    const msg = formatTelegramMessage(ROW, few, 4663);
    expect(msg).toContain(`fewer than ${MIN_PEERS} qualified launches`);
    expect(msg).not.toContain('riskiest');
  });

  it('states the measured commit lag instead of an unqualified "committed before outcome"', () => {
    const msg = formatTelegramMessage(ROW, PEERS, 4663);
    expect(msg).toContain('Committed 7 min after its T+10m anchor');
    expect(msg).not.toContain('committed before outcome');
  });

  // Merkle batching means many launches share one commit tx — linking only
  // that made consecutive posts all point at the same hash, which reads as a
  // bug to anyone who doesn't know the design.
  it('leads with the per-report verify link and labels the tx as a batch anchor', () => {
    const msg = formatTelegramMessage(ROW, PEERS, 4663, 'https://api.example.test/');
    expect(msg).toContain(`https://api.example.test/v1/receipt/${ROW.reportHash}`);
    expect(msg).toContain('Batch anchor');
    expect(msg).not.toContain('api.example.test//v1'); // trailing slash trimmed
  });

  it('omits the verify link when no api base is configured', () => {
    const msg = formatTelegramMessage(ROW, PEERS, 4663);
    expect(msg).not.toContain('v1/receipt');
    expect(msg).toContain(ROW.reportHash);
  });
});

describe('isFresh', () => {
  it('accepts a batch committed within 30 minutes of the anchor', () => {
    expect(isFresh({ ...ROW, committedAt: minutesAfter(30) })).toBe(true);
  });

  // 18 Sep: reports built hours late during the RPC outage were posted as "New
  // qualified launch" with their windows already partly observed.
  it('rejects one committed later, or not committed at all', () => {
    expect(isFresh({ ...ROW, committedAt: minutesAfter(31) })).toBe(false);
    expect(isFresh({ ...ROW, committedAt: minutesAfter(13 * 60) })).toBe(false);
    expect(isFresh({ ...ROW, committedAt: null })).toBe(false);
  });
});

describe('postQualifiedLaunches', () => {
  const readPeers = async (): Promise<PeerScores> => PEERS;

  it('posts each fresh candidate, ranked against its own peer window, and marks it posted', async () => {
    const send = vi.fn(async () => {});
    const markPosted = vi.fn(async () => {});
    const peerReader = vi.fn(readPeers);
    const result = await postQualifiedLaunches({
      chainId: 4663,
      send,
      readCandidates: async () => [ROW],
      readPeers: peerReader,
      markPosted,
    });
    expect(result).toEqual({ candidates: 1, stale: 0, posted: 1, failed: 0 });
    expect(peerReader).toHaveBeenCalledWith(ANCHOR);
    expect(markPosted).toHaveBeenCalledWith('r1');
  });

  it('never posts a stale report and does not let stale ones use up the per-sweep limit', async () => {
    const stale = Array.from({ length: 5 }, (_, i) => ({ ...ROW, id: `s${i}`, committedAt: minutesAfter(13 * 60) }));
    const fresh = { ...ROW, id: 'f1' };
    const send = vi.fn(async () => {});
    const markPosted = vi.fn(async () => {});
    const result = await postQualifiedLaunches({
      chainId: 4663,
      send,
      readCandidates: async () => [...stale, fresh],
      readPeers,
      markPosted,
      limit: 1,
    });
    expect(result).toEqual({ candidates: 6, stale: 5, posted: 1, failed: 0 });
    expect(markPosted).toHaveBeenCalledTimes(1);
    expect(markPosted).toHaveBeenCalledWith('f1');
  });

  it('leaves a failed send unmarked so it retries next sweep, and keeps processing the rest', async () => {
    const rowB = { ...ROW, id: 'r2', tokenAddress: '0xb00000000000000000000000000000000000b0' };
    const send = vi.fn(async (text: string) => {
      if (text.includes(ROW.tokenAddress)) throw new Error('telegram 500');
    });
    const markPosted = vi.fn(async () => {});
    const result = await postQualifiedLaunches({
      chainId: 4663,
      send,
      readCandidates: async () => [ROW, rowB],
      readPeers,
      markPosted,
    });
    expect(result).toEqual({ candidates: 2, stale: 0, posted: 1, failed: 1 });
    expect(markPosted).toHaveBeenCalledTimes(1);
    expect(markPosted).toHaveBeenCalledWith('r2');
  });

  it('does nothing when there are no unposted qualified reports', async () => {
    const send = vi.fn(async () => {});
    const result = await postQualifiedLaunches({ chainId: 4663, send, readCandidates: async () => [], readPeers });
    expect(result).toEqual({ candidates: 0, stale: 0, posted: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
