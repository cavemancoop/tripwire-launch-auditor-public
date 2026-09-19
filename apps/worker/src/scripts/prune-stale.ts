import { prisma } from '@launch-auditor/db';
import type { Hex } from 'viem';
import { loadEnv } from '../env';
import { checkTokenFreshness } from '../watcher/freshness';
import { rpc } from '../watcher/rpc';

// pnpm watcher:prune-stale [--apply]
//   Re-checks every indexed launch's token freshness (spec §0: new-token
//   launches only) via eth_getCode and reports — or with --apply, deletes —
//   ones that turn out to be a fresh pool for an already-established token
//   (e.g. a tokenized stock paired with USDG).  Dry run by default.

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { chainId } = loadEnv();
  const client = rpc();

  const launches = await prisma.launch.findMany({
    where: { chainId },
    orderBy: { launchBlock: 'asc' },
  });
  console.log(`checking ${launches.length} launches via eth_getCode...`);

  let stale = 0;
  let inconclusive = 0;
  for (const l of launches) {
    const r = await checkTokenFreshness(client, l.tokenAddress as Hex, l.launchBlock);
    if (r.reason === 'inconclusive') inconclusive += 1;
    if (!r.isFreshLaunch) {
      stale += 1;
      console.log(
        `${apply ? 'DELETING' : 'STALE   '} ${l.tokenAddress} (had code by block ${r.checkedAtBlock}, launch block ${l.launchBlock})`,
      );
      if (apply) await prisma.launch.delete({ where: { id: l.id } });
    }
    await new Promise((res) => setTimeout(res, 150)); // stay well under the RPC's 600 req/min, shared with a live watcher
  }

  console.log(
    `${stale} of ${launches.length} were not new-token launches (${inconclusive} inconclusive, kept).` +
      (apply ? ' Deleted.' : ' Re-run with --apply to delete them.'),
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
