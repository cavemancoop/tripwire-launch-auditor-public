import { recommitArtifacts, runCommitJob } from '../commit';

// pnpm commit:run [--force]              — run one report-batch commit pass now.
// pnpm commit:run --artifacts [--force]  — re-post changed artifact hashes on-chain
//                                          (--force re-posts all, even unchanged).

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  if (process.argv.includes('--artifacts')) {
    const r = await recommitArtifacts({ force });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const r = await runCommitJob({ force });
  console.log(JSON.stringify(r, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
