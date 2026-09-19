import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import { loadEnv } from '../env';
import { runOutcomesLoop, sweepDueOutcomes } from '../outcomes';

// pnpm outcomes:run [--loop] [--limit N]
//   default: one sweep of due outcomes. --loop: keep sweeping every 60s.

async function main(): Promise<void> {
  const { rpcUrl } = loadEnv();
  const client = getBudgetedClient(rpcUrl, { priority: PRIORITY.outcomes });

  const limIdx = process.argv.indexOf('--limit');
  const limit = limIdx >= 0 ? Number(process.argv[limIdx + 1]) : 50;

  if (process.argv.includes('--loop')) {
    const signal = { stopped: false };
    process.on('SIGINT', () => (signal.stopped = true));
    await runOutcomesLoop(client, signal, { batch: limit });
    return;
  }

  const r = await sweepDueOutcomes(client, limit);
  console.log(JSON.stringify(r, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
