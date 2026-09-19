import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scoreBenchmark, type Benchmark } from '@launch-auditor/scoring';
import { collectScoreRows, type CollectOptions } from './collect';

export interface RunScorerOptions {
  thresholds?: number[];
  scope?: CollectOptions['scope'];
  /** write the full benchmark JSON here */
  out?: string;
}

/** Collect resolved outcomes + forecaster predictions and build the spec §2 table. */
export async function runScorer(opts: RunScorerOptions = {}): Promise<{
  benchmark: Benchmark;
  rowCount: number;
}> {
  const { rows, exclusions } = await collectScoreRows({ scope: opts.scope });
  const benchmark = { ...scoreBenchmark(rows, { thresholds: opts.thresholds }), exclusions };
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(benchmark, null, 2));
  }
  return { benchmark, rowCount: rows.length };
}

/** Compact human summary of the "all" section. */
export function summariseBenchmark(bench: Benchmark): string {
  const all = bench.sections.find((s) => s.splitBy === 'all');
  const lines: string[] = [
    `Benchmark @ ${bench.generatedAt}  (show n>=${bench.minForMetrics}, claim n>=${bench.minForClaims})`,
  ];
  for (const [ok, cells] of Object.entries(all?.byOutcome ?? {})) {
    lines.push(`── ${ok}`);
    for (const c of cells ?? []) {
      const auc = c.auroc === null ? 'n/a' : c.auroc.toFixed(3);
      const bss = c.brierSkill === null ? 'n/a' : c.brierSkill.toFixed(3);
      const claim = c.comparisons.find((x) => x.claimAllowed);
      lines.push(
        `   ${c.forecaster.padEnd(16)} AUROC ${auc.padStart(5)}  BSS ${bss.padStart(6)}  ` +
          `base ${c.baseRate.toFixed(3)}  n=${c.n}${c.insufficientSample ? ' (insufficient)' : ''}` +
          (claim ? `  ✓ beats ${claim.vs} p=${claim.p}` : ''),
      );
    }
  }
  return lines.join('\n');
}
