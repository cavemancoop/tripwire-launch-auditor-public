/**
 * M7 — periodic benchmark snapshot. `GET /v1/benchmark` is served by the API
 * process, which has no scoring compute of its own (deliberately — it's the
 * lightweight, publicly-facing half). The worker recomputes the benchmark
 * every tick; the API just reads the latest one.
 *
 * M9: also persisted to Postgres (`BenchmarkSnapshot`, a singleton row), not
 * only the local file. Fork-and-run (spec §8.1, one machine) can share a
 * filesystem, but on Railway api and worker are separate services with
 * separate filesystems — Postgres is the one thing every deployment topology
 * already shares. The file write stays (cheap, useful for local debugging);
 * the DB write is what `GET /v1/benchmark` actually reads in every topology.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prisma } from '@launch-auditor/db';
import type { Benchmark } from '@launch-auditor/scoring';
import { runScorer, type RunScorerOptions } from './benchmark';
import {
  prismaCoverageReader,
  qualifiedOnlyFromEnv,
  resolutionPolicy,
  type CoverageByCell,
  type CoverageReader,
} from './coverage';
import { recordFailure } from '../failures';
import type { StopSignal } from '../watcher/poller';

/**
 * Walk up from `startDir` for the workspace root. The worker and the API run
 * as two processes with two different cwds (`pnpm --filter X start` sets cwd
 * to that package's directory) — a bare relative path like `data/benchmark.json`
 * silently resolves to two different files, and the API never sees what the
 * worker wrote. Anchor both to the same repo root instead.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export interface ScorerLoopOptions {
  intervalMs?: number;
  outFile?: string;
  /** injectable for tests — defaults to the real `runScorer` (hits Prisma) */
  scorer?: (opts: RunScorerOptions) => ReturnType<typeof runScorer>;
  /** injectable for tests — defaults to a real Postgres upsert */
  persist?: (snapshot: BenchmarkSnapshot) => Promise<void>;
  /** injectable for tests — defaults to Prisma outcome counts */
  readCoverage?: CoverageReader;
  qualifiedOnly?: boolean;
}

const defaultPersist = async (snapshot: BenchmarkSnapshot): Promise<void> => {
  await prisma.benchmarkSnapshot.upsert({
    where: { key: 'latest' },
    create: { key: 'latest', json: snapshot as never, generatedAt: new Date(snapshot.generatedAt) },
    update: { json: snapshot as never, generatedAt: new Date(snapshot.generatedAt) },
  });
};

/**
 * M8 — the dashboard's benchmark table wants a "retrospective" badge on
 * backfill-inclusive cells (build-guide M8). `collectScoreRows` already
 * supports `scope: 'live' | 'retrospective' | 'both'`; rather than teach the
 * scorer package itself to tag individual rows, the snapshot runs it twice
 * and ships both — the difference in a cell's `n` between `all` and `live`
 * is exactly the retrospective (backfill) contribution, which the dashboard
 * can display without any scorer changes. The one-shot `scorer:run` CLI
 * script is unaffected — it still calls `runScorer()` directly and writes a
 * single raw `Benchmark`, which is fine for its own ad-hoc use.
 */
export interface BenchmarkSnapshot {
  generatedAt: string;
  all: Benchmark;
  live: Benchmark;
  /** M12c: graded vs pending vs unresolvable outcome rows per cell (live rows) */
  coverage?: CoverageByCell;
  /** M12c: how the rows that did get graded were chosen */
  resolutionPolicy?: string;
}

export async function runScorerLoop(
  signal: StopSignal,
  opts: ScorerLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 300_000; // 5 min — matches the commit cadence
  const outFile = opts.outFile ?? join(findRepoRoot(process.cwd()), 'data', 'benchmark.json');
  const scorer = opts.scorer ?? runScorer;
  const persist = opts.persist ?? defaultPersist;
  const readCoverage = opts.readCoverage ?? prismaCoverageReader;
  const policy = resolutionPolicy(opts.qualifiedOnly ?? qualifiedOnlyFromEnv());
  mkdirSync(dirname(outFile), { recursive: true });

  // eslint-disable-next-line no-console
  console.log(`[scorer] snapshot loop every ${intervalMs / 1000}s → Postgres + ${outFile}`);
  while (!signal.stopped) {
    try {
      const now = new Date();
      const [both, live, coverage] = await Promise.all([scorer({}), scorer({ scope: 'live' }), readCoverage(now)]);
      const snapshot: BenchmarkSnapshot = {
        generatedAt: now.toISOString(),
        all: both.benchmark,
        live: live.benchmark,
        coverage,
        resolutionPolicy: policy,
      };
      await persist(snapshot);
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
      // eslint-disable-next-line no-console
      console.log(`[scorer] snapshot: ${both.rowCount} rows (${live.rowCount} live) → Postgres + ${outFile}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scorer] snapshot failed', err instanceof Error ? err.message : err);
      await recordFailure('scorer.snapshot_failed', err);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
