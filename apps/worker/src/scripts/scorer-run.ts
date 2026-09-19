import { runScorer, summariseBenchmark } from '../scorer';

// pnpm scorer:run [--out path.json] [--thresholds 0.5,0.7] [--scope live|retrospective|both]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const thresholds = arg('--thresholds')?.split(',').map(Number);
  const scope = arg('--scope') as 'live' | 'retrospective' | 'both' | undefined;
  const out = arg('--out');

  const { benchmark, rowCount } = await runScorer({ thresholds, scope, out });
  console.error(`${rowCount} score rows, ${benchmark.sections.length} sections`);

  if (out) {
    console.error(`wrote ${out}`);
    console.log(summariseBenchmark(benchmark));
  } else {
    console.log(JSON.stringify(benchmark, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
