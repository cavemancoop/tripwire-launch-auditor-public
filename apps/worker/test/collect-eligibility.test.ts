import { beforeEach, describe, expect, it, vi } from 'vitest';

// The collector reads Postgres directly; stub just the queries it makes.
const db = vi.hoisted(() => ({
  outcomes: [] as unknown[],
  reports: [] as unknown[],
  features: [] as unknown[],
}));
vi.mock('@launch-auditor/db', () => ({
  prisma: {
    outcome: { findMany: async () => db.outcomes },
    report: { findMany: async () => db.reports },
    feature: { findMany: async () => db.features },
    launch: { findUnique: async () => ({ source: 'raw' }) },
  },
}));

const { collectScoreRows } = await import('../src/scorer/collect');

const at = (iso: string): Date => new Date(iso);
const TIMELY = '0x' + 'a'.repeat(40); // audit post 3180: committed 27 s after its anchor
const REPLAY = '0xafb2e8581cc8e7c125163d1efe0061d8632ee458'; // audit post 4117: 11h36m45s late
const ANCHOR = { [TIMELY]: at('2026-09-17T13:34:13Z'), [REPLAY]: at('2026-09-18T13:47:34Z') };
const BLOCK = { [TIMELY]: 100n, [REPLAY]: 200n };
const BLOCK_TIME: Record<string, Date> = { '100': at('2026-09-17T13:34:40Z'), '200': at('2026-09-19T01:24:19Z') };

function outcome(token: string, label: string, horizon: string, value: boolean) {
  return { chainId: 4663, tokenAddress: token, anchorTime: ANCHOR[token]!, trigger: 'launch', launchId: `L-${token}`, label, horizon, value };
}
function report(token: string, forecaster: string, p: number) {
  return {
    chainId: 4663,
    tokenAddress: token,
    reportTime: ANCHOR[token]!,
    trigger: 'launch',
    launchId: `L-${token}`,
    forecaster,
    commitId: `C-${token}`,
    commit: { blockNumber: BLOCK[token]! },
    launch: { source: 'raw' },
    pInsiderExit6h: p,
    pInsiderExit24h: p,
  };
}

beforeEach(() => {
  db.outcomes = [
    outcome(TIMELY, 'INSIDER_EXIT', '6h', true),
    outcome(TIMELY, 'INSIDER_EXIT', '24h', true),
    outcome(REPLAY, 'INSIDER_EXIT', '6h', false),
    outcome(REPLAY, 'INSIDER_EXIT', '24h', false),
  ];
  db.reports = [
    report(TIMELY, 'det_v0', 0.7),
    report(TIMELY, 'heuristic_v1', 0.8),
    report(REPLAY, 'det_v0', 0.2),
    report(REPLAY, 'heuristic_v1', 0.2),
  ];
  db.features = [
    // ScanHood fetched 4 min after the anchor for the timely launch, 11h later for the replay
    { launch: { id: `L-${TIMELY}`, source: 'raw' }, scanhoodRaw: { verdict: 'danger' }, scanhoodFetchedAt: at('2026-09-17T13:38:00Z'), goplusRaw: null, goplusFetchedAt: null },
    { launch: { id: `L-${REPLAY}`, source: 'raw' }, scanhoodRaw: { verdict: 'danger' }, scanhoodFetchedAt: at('2026-09-19T01:20:00Z'), goplusRaw: null, goplusFetchedAt: null },
  ];
});

const blockTimeOf = async (b: bigint): Promise<Date | null> => BLOCK_TIME[b.toString()] ?? null;

describe('collectScoreRows — timing eligibility', () => {
  it('scores only the timely launch; every forecaster for the replay is excluded', async () => {
    const { rows } = await collectScoreRows({ blockTimeOf });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.obsId.includes(TIMELY))).toBe(true);
    expect(new Set(rows.map((r) => r.forecaster))).toEqual(new Set(['det_v0', 'heuristic_v1', 'base_rate', 'base_rate_fixed', 'scanhood']));
  });

  it('counts the replay as late on the ended 6h horizon and replay on the open 24h one', async () => {
    const { exclusions } = await collectScoreRows({ blockTimeOf });
    expect(exclusions['INSIDER_EXIT@6h']!['det_v0']).toEqual({ eligible: 1, late: 1 });
    expect(exclusions['INSIDER_EXIT@24h']!['det_v0']).toEqual({ eligible: 1, replay: 1 });
    // computed forecasters inherit det_v0's class for the same observation
    expect(exclusions['INSIDER_EXIT@6h']!['base_rate']).toEqual({ eligible: 1, late: 1 });
    expect(exclusions['INSIDER_EXIT@24h']!['scanhood']).toEqual({ eligible: 1, replay: 1 });
  });

  it('excludes a report whose commit block time cannot be read, as missing_time — never a guess', async () => {
    const { rows, exclusions } = await collectScoreRows({ blockTimeOf: async () => null });
    expect(rows).toEqual([]);
    expect(exclusions['INSIDER_EXIT@24h']!['det_v0']).toEqual({ missing_time: 2 });
  });

  it('excludes an uncommitted report', async () => {
    db.reports = db.reports.map((r) => ({ ...(r as object), commitId: null, commit: null }));
    const { rows, exclusions } = await collectScoreRows({ blockTimeOf });
    expect(rows).toEqual([]);
    expect(exclusions['INSIDER_EXIT@6h']!['heuristic_v1']).toEqual({ uncommitted: 2 });
  });

  it('drops a scanner row fetched too late even when the report itself was timely', async () => {
    (db.features[0] as { scanhoodFetchedAt: Date }).scanhoodFetchedAt = at('2026-09-17T18:00:00Z');
    const { rows, exclusions } = await collectScoreRows({ blockTimeOf });
    expect(rows.some((r) => r.forecaster === 'scanhood')).toBe(false);
    expect(rows.some((r) => r.forecaster === 'det_v0')).toBe(true);
    expect(exclusions['INSIDER_EXIT@24h']!['scanhood']).toEqual({ replay: 2 });
  });
});
