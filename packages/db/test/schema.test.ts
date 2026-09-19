import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(
  fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

function enumValues(name: string): string[] {
  const m = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!m) throw new Error(`enum ${name} not found`);
  return m[1]!
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
}

describe('prisma schema', () => {
  it('defines the mechanical outcomes from spec §1 (+ TRADING_ALIVE, M4e)', () => {
    expect(enumValues('OutcomeLabel').sort()).toEqual(
      ['DRAWDOWN_80', 'INSIDER_EXIT', 'LIQ_IMPAIRED', 'SELL_IMPAIRED', 'TRADING_ALIVE'].sort(),
    );
  });

  it('defines the forecasters scored side by side in spec §2', () => {
    const kinds = enumValues('ForecasterKind');
    for (const k of ['base_rate', 'base_rate_fixed', 'heuristic_v1', 'det_v0', 'llm_deepdive_v0', 'scanhood', 'goplus']) {
      expect(kinds).toContain(k);
    }
  });

  it('maps the seven build-guide tables plus the M1 watcher cursor', () => {
    for (const table of [
      'launches',
      'features',
      'reports',
      'commits',
      'outcomes',
      'lifecycle_log',
      'receipts',
      'watcher_cursors',
    ]) {
      expect(schema).toContain(`@@map("${table}")`);
    }
  });

  it('keeps Launch.source open (string, not an enum) for the churning pad set', () => {
    expect(schema).not.toMatch(/enum LaunchSource/);
    const launch = schema.match(/model Launch \{([\s\S]*?)\n\}/)![1]!;
    expect(launch).toMatch(/source\s+String\s+@default\("unknown"\)/);
    expect(launch).toMatch(/poolKind\s+String\?/);
    expect(launch).toMatch(/poolId\s+String\?/); // v4 pools have a bytes32 id, no address
    expect(launch).toMatch(/detectedVia\s+String\?/);
  });

  it('carries the Metabolism state machine (spec §8)', () => {
    expect(enumValues('LifecycleState').sort()).toEqual(
      ['ACTIVE', 'DRAINING', 'NO_KEY', 'REVOKING', 'ROTATING', 'STARVED'].sort(),
    );
  });

  it('is not launch-shaped: reports carry reportTime + trigger (spec §1.1)', () => {
    expect(enumValues('ReportTrigger').sort()).toEqual(
      ['event', 'launch', 'on_demand', 'qualified', 'scheduled'].sort(),
    );
    const report = schema.match(/model Report \{([\s\S]*?)\n\}/)![1]!;
    expect(report).toMatch(/reportTime\s+DateTime/);
    expect(report).toMatch(/trigger\s+ReportTrigger/);
    expect(report).toMatch(/launchId\s+String\?/); // launch link is optional
    expect(report).toMatch(/ageHours\s+Float\?/);
  });

  it('anchors outcomes to anchorTime, not launch (spec §1.1)', () => {
    const outcome = schema.match(/model Outcome \{([\s\S]*?)\n\}/)![1]!;
    expect(outcome).toMatch(/anchorTime\s+DateTime/);
    expect(outcome).toMatch(/trigger\s+ReportTrigger/);
    expect(outcome).toContain(
      '@@unique([chainId, tokenAddress, anchorTime, label, horizon, ruleVersion])',
    );
  });

  it('keeps verbatim external-scanner blobs with fetch timestamps (spec §3.3)', () => {
    expect(schema).toMatch(/goplusRaw\s+Json\?/);
    expect(schema).toMatch(/goplusFetchedAt\s+DateTime\?/);
    expect(schema).toMatch(/scanhoodRaw\s+Json\?/);
    expect(schema).toMatch(/scanhoodFetchedAt\s+DateTime\?/);
  });
});
