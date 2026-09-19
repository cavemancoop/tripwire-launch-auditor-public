import { logit } from '@launch-auditor/scoring';
import { observedBaseRates, runBackfill } from '../backfill/run';

// pnpm backfill --days N [--max-calls M] [--max-launches K] [--end-hours-ago H]
//               [--dry-run] [--resolve-only] [--features-only] [--skip-features]
//               [--refeature] [--only-label L1,L2] [--exclude-label L1,L2]
//               [--spread] [--lane-qualified] [--all-heavy] [--from-block B] [--to-block B]
//   --skip-features : resolve outcomes on already-featured launches, no feature backfill
//   --repool        : cheap — just re-derive each retrospective launch's primary
//                     v4 pool (~4 getLogs each) after the pool-selection fix
//   --refeature     : re-run the full T+10m for EVERY retrospective launch
//   --only-label X  : resolve just that cell (fill a sparse base rate)
//   --exclude-label INSIDER_EXIT : skip a slow cell so 72h/7d/TRADING_ALIVE get reached
//   --spread        : resolve across cells, not oldest-horizon-first
//   --lane-qualified: every label restricted to qualified-lane launches
//   Reconstruct features + outcomes for launches in the window (spec §7,
//   retrospective=true). chain 4663 runs ~14k launches/day, so for a base-rate
//   pass use --max-launches (sample from the front) and --end-hours-ago 25
//   (so the 24h horizon has already passed). Prints observed base rates + the
//   det_v0.1 intercept suggestions (checkpoint §8.3).
//   e.g.  pnpm backfill --days 3 --end-hours-ago 25 --max-launches 800 --max-calls 120000

function num(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
function str(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function big(name: string): bigint | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? BigInt(process.argv[i + 1]!) : undefined;
}

async function main(): Promise<void> {
  const days = num('--days', 14);
  const maxCalls = num('--max-calls', 0);
  const maxLaunches = num('--max-launches', 0);
  const endHoursAgo = num('--end-hours-ago', 0);

  const res = await runBackfill({
    days,
    maxCalls,
    maxLaunches: maxLaunches > 0 ? maxLaunches : undefined,
    endHoursAgo: endHoursAgo > 0 ? endHoursAgo : undefined,
    confidentOnly: process.argv.includes('--confident-only'),
    dryRun: process.argv.includes('--dry-run'),
    resolveOnly: process.argv.includes('--resolve-only'),
    featuresOnly: process.argv.includes('--features-only'),
    skipFeatures: process.argv.includes('--skip-features'),
    onlyLabels: str('--only-label')?.split(','),
    excludeLabels: str('--exclude-label')?.split(','),
    sweepOrder: process.argv.includes('--spread') ? 'spread' : undefined,
    laneQualifiedOnly: process.argv.includes('--lane-qualified'),
    refeature: process.argv.includes('--refeature'),
    repool: process.argv.includes('--repool'),
    qualifiedOnly: !process.argv.includes('--all-heavy'),
    fromBlock: big('--from-block'),
    toBlock: big('--to-block'),
  });

  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const printRates = (
    label: string,
    rates: Array<{ key: string; n: number; positives: number; rate: number }>,
  ) => {
    console.log(`\n── observed base rates — ${label} ──`);
    if (rates.length === 0) {
      console.log('  (none resolved yet)');
      return;
    }
    for (const r of rates) {
      const suggested = logit(r.rate);
      console.log(
        `  ${r.key.padEnd(20)} n=${String(r.n).padStart(4)}  positives=${String(r.positives).padStart(4)}  ` +
          `rate=${r.rate.toFixed(4)}  ->  det_v0.1 biasOverride ${suggested.toFixed(3)}`,
      );
    }
  };

  const ratesAll = await observedBaseRates();
  const ratesQ = await observedBaseRates({ qualifiedLaneOnly: true });
  printRates('qualified lane only (use these for det_v0.1)', ratesQ);
  printRates('all retrospective (incl. non-qualified noise)', ratesAll);
  console.log(
    '\nTo apply: copy the qualified-lane biasOverride values into\n' +
      'packages/scoring/weights/det_v0_1.json. Cells with n<20: keep the det_v0 prior.\n' +
      'Note: DRAWDOWN/LIQ rates are likely UNDER-stated — the deadest tokens have no\n' +
      'price/liquidity series and resolve UNRESOLVABLE, so they drop out of the denominator.',
  );
  console.log('\n' + JSON.stringify({ ...res, baseRates: ratesQ, baseRatesAll: ratesAll }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
