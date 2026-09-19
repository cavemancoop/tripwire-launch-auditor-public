import { describe, expect, it } from 'vitest';
import { horizonMs } from '../src/outcomes/resolve';
import {
  REPLAY_AFTER_MS,
  classifyEligibility,
  countExclusion,
  scannerFetchIsTimely,
  type ExclusionCounts,
} from '../src/scorer/eligibility';

const at = (iso: string): Date => new Date(iso);
const horizonEnd = (anchor: Date, h: string): Date => new Date(anchor.getTime() + horizonMs(h));

describe('classifyEligibility', () => {
  // The 2026-09-19 audit's outage replay: token 0xafb2e8581cc8e7c125163d1efe0061d8632ee458,
  // Telegram post 4117. reportTime (T+10m block) 2026-09-18 13:47:34Z; the batch
  // holding it landed in a block at 2026-09-19 01:24:19Z — 11h36m45s later.
  const replayAnchor = at('2026-09-18T13:47:34Z');
  const replayCommit = at('2026-09-19T01:24:19Z');

  it('marks the audit replay late on the horizons that had already ended (1h, 6h)', () => {
    for (const h of ['1h', '6h']) {
      expect(
        classifyEligibility({ reportTime: replayAnchor, committed: true, commitBlockTime: replayCommit, horizonEnd: horizonEnd(replayAnchor, h) }),
      ).toBe('late');
    }
  });

  it('marks it replay — never eligible — on the horizons still open (24h, 72h, 7d)', () => {
    for (const h of ['24h', '72h', '7d']) {
      expect(
        classifyEligibility({ reportTime: replayAnchor, committed: true, commitBlockTime: replayCommit, horizonEnd: horizonEnd(replayAnchor, h) }),
      ).toBe('replay');
    }
  });

  // The audit's timely samples: posts 3180 (27 s) and 3199 (5m16s).
  it('keeps normally committed reports eligible on every horizon', () => {
    for (const [anchor, commit] of [
      ['2026-09-17T13:34:13Z', '2026-09-17T13:34:40Z'],
      ['2026-09-17T13:58:33Z', '2026-09-17T14:03:49Z'],
    ] as const) {
      for (const h of ['1h', '6h', '24h', '72h', '7d']) {
        expect(
          classifyEligibility({ reportTime: at(anchor), committed: true, commitBlockTime: at(commit), horizonEnd: horizonEnd(at(anchor), h) }),
        ).toBe('eligible');
      }
    }
  });

  it('draws the replay line at 30 minutes after the anchor', () => {
    const a = at('2026-09-17T12:00:00Z');
    const end = horizonEnd(a, '24h');
    expect(classifyEligibility({ reportTime: a, committed: true, commitBlockTime: new Date(a.getTime() + REPLAY_AFTER_MS), horizonEnd: end })).toBe('eligible');
    expect(classifyEligibility({ reportTime: a, committed: true, commitBlockTime: new Date(a.getTime() + REPLAY_AFTER_MS + 1000), horizonEnd: end })).toBe('replay');
  });

  it('counts a commit exactly at the horizon end as late', () => {
    const a = at('2026-09-17T12:00:00Z');
    const end = horizonEnd(a, '1h');
    expect(classifyEligibility({ reportTime: a, committed: true, commitBlockTime: end, horizonEnd: end })).toBe('late');
  });

  it('separates uncommitted reports from committed ones whose block time could not be read', () => {
    const a = at('2026-09-17T12:00:00Z');
    const end = horizonEnd(a, '24h');
    expect(classifyEligibility({ reportTime: a, committed: false, commitBlockTime: null, horizonEnd: end })).toBe('uncommitted');
    expect(classifyEligibility({ reportTime: a, committed: true, commitBlockTime: null, horizonEnd: end })).toBe('missing_time');
  });
});

describe('scannerFetchIsTimely', () => {
  it('accepts a fetch within 30 min of the anchor and rejects a late or missing one', () => {
    const a = at('2026-09-18T13:47:34Z');
    expect(scannerFetchIsTimely(a, new Date(a.getTime() + 5 * 60_000))).toBe(true);
    expect(scannerFetchIsTimely(a, at('2026-09-19T01:20:00Z'))).toBe(false);
    expect(scannerFetchIsTimely(a, null)).toBe(false);
  });
});

describe('countExclusion', () => {
  it('tallies per outcome, forecaster and class', () => {
    const c: ExclusionCounts = {};
    countExclusion(c, 'INSIDER_EXIT@6h', 'det_v0', 'late');
    countExclusion(c, 'INSIDER_EXIT@6h', 'det_v0', 'late');
    countExclusion(c, 'INSIDER_EXIT@6h', 'det_v0', 'eligible');
    expect(c).toEqual({ 'INSIDER_EXIT@6h': { det_v0: { late: 2, eligible: 1 } } });
  });
});
