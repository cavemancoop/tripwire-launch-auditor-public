import { describe, expect, it } from 'vitest';
import { applyAlertTransitions, evaluateAlerts, runAlertLoop, type AlertCheck, type AlertReaders } from '../src/alerts';
import type { StopSignal } from '../src/watcher/poller';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function readers(overrides: Partial<AlertReaders> = {}): AlertReaders {
  return {
    latestLifecycle: async () => ({ newState: 'ACTIVE', idsMismatch: false }),
    latestPhantomEpoch: async () => false,
    latestCommitAt: async () => new Date(NOW.getTime() - 60_000),
    latestWatcherUpdate: async () => new Date(NOW.getTime() - 30_000),
    ...overrides,
  };
}

describe('evaluateAlerts', () => {
  it('reports every check ok when everything is fresh and healthy', async () => {
    const checks = await evaluateAlerts({ now: NOW, readers: readers() });
    expect(checks.every((c) => !c.bad)).toBe(true);
  });

  it('flags starved from the latest lifecycle state', async () => {
    const checks = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestLifecycle: async () => ({ newState: 'STARVED', idsMismatch: false }) }),
    });
    expect(checks.find((c) => c.key === 'starved')?.bad).toBe(true);
  });

  it('flags ids_trip from idsMismatch OR a phantom epoch', async () => {
    const viaMismatch = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestLifecycle: async () => ({ newState: 'ACTIVE', idsMismatch: true }) }),
    });
    expect(viaMismatch.find((c) => c.key === 'ids_trip')?.bad).toBe(true);

    const viaPhantom = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestPhantomEpoch: async () => true }),
    });
    expect(viaPhantom.find((c) => c.key === 'ids_trip')?.bad).toBe(true);
  });

  it('flags commit_lag past the threshold (default 10 min) but not before it', async () => {
    const justUnder = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestCommitAt: async () => new Date(NOW.getTime() - 599_000) }),
    });
    expect(justUnder.find((c) => c.key === 'commit_lag')?.bad).toBe(false);

    const justOver = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestCommitAt: async () => new Date(NOW.getTime() - 601_000) }),
    });
    expect(justOver.find((c) => c.key === 'commit_lag')?.bad).toBe(true);
  });

  it('flags watcher_stalled past the threshold (default 5 min)', async () => {
    const stalled = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestWatcherUpdate: async () => new Date(NOW.getTime() - 301_000) }),
    });
    expect(stalled.find((c) => c.key === 'watcher_stalled')?.bad).toBe(true);
  });

  it('does not flag commit_lag or watcher_stalled when there is no row yet (fresh instance)', async () => {
    const checks = await evaluateAlerts({
      now: NOW,
      readers: readers({ latestCommitAt: async () => null, latestWatcherUpdate: async () => null }),
    });
    expect(checks.find((c) => c.key === 'commit_lag')?.bad).toBe(false);
    expect(checks.find((c) => c.key === 'watcher_stalled')?.bad).toBe(false);
  });

  it('respects custom thresholds', async () => {
    const checks = await evaluateAlerts({
      now: NOW,
      commitLagSec: 30,
      readers: readers({ latestCommitAt: async () => new Date(NOW.getTime() - 60_000) }),
    });
    expect(checks.find((c) => c.key === 'commit_lag')?.bad).toBe(true);
  });
});

const CHECK = (key: AlertCheck['key'], bad: boolean): AlertCheck => ({ key, bad, detail: bad ? 'bad' : 'ok' });

describe('applyAlertTransitions', () => {
  it('sends one message on ok->bad', async () => {
    const sent: string[] = [];
    const lastBad = new Map<AlertCheck['key'], boolean>();
    await applyAlertTransitions([CHECK('starved', true)], lastBad, async (t) => void sent.push(t));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('STARVED');
    expect(lastBad.get('starved')).toBe(true);
  });

  it('stays quiet on bad->bad (already alerted)', async () => {
    const sent: string[] = [];
    const lastBad = new Map<AlertCheck['key'], boolean>([['starved', true]]);
    await applyAlertTransitions([CHECK('starved', true)], lastBad, async (t) => void sent.push(t));
    expect(sent).toHaveLength(0);
  });

  it('sends one recovery message on bad->ok', async () => {
    const sent: string[] = [];
    const lastBad = new Map<AlertCheck['key'], boolean>([['commit_lag', true]]);
    await applyAlertTransitions([CHECK('commit_lag', false)], lastBad, async (t) => void sent.push(t));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('recovered');
    expect(lastBad.get('commit_lag')).toBe(false);
  });

  it('stays quiet on ok->ok', async () => {
    const sent: string[] = [];
    const lastBad = new Map<AlertCheck['key'], boolean>([['watcher_stalled', false]]);
    await applyAlertTransitions([CHECK('watcher_stalled', false)], lastBad, async (t) => void sent.push(t));
    expect(sent).toHaveLength(0);
  });

  it('does not let one failed send stop tracking that check\'s new state', async () => {
    const lastBad = new Map<AlertCheck['key'], boolean>();
    await applyAlertTransitions([CHECK('ids_trip', true)], lastBad, async () => {
      throw new Error('telegram down');
    });
    expect(lastBad.get('ids_trip')).toBe(true);
  });
});

describe('runAlertLoop', () => {
  it('over three ticks: alerts once on the first bad tick, stays quiet on the second, and sends a recovery on the third', async () => {
    const sent: string[] = [];
    const ticks: AlertCheck[][] = [
      [CHECK('starved', true)],
      [CHECK('starved', true)],
      [CHECK('starved', false)],
    ];
    let i = 0;
    const signal: StopSignal = { stopped: false };

    await runAlertLoop(
      signal,
      { botToken: 'tkn', chatId: 'chat', intervalMs: 1 },
      {
        evaluate: async () => {
          const checks = ticks[i]!;
          i += 1;
          if (i >= ticks.length) signal.stopped = true;
          return checks;
        },
        send: async (t) => void sent.push(t),
      },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('STARVED');
    expect(sent[1]).toContain('recovered');
  });
});
