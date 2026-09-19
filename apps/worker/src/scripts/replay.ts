import { loadEnv } from '../env';
import { POOLS_STREAM, getCursor, setCursor } from '../watcher/cursor';
import { pollOnce } from '../watcher/poller';
import { rpc } from '../watcher/rpc';

// pnpm watcher:replay --from <block>
//   Rewinds the pool-creation cursor and re-ingests forward to head in windows.

function parseArgs(argv: string[]): { from: bigint; span: bigint } {
  const i = argv.indexOf('--from');
  if (i === -1 || !argv[i + 1]) {
    throw new Error('usage: pnpm watcher:replay --from <block> [--span <blocks>]');
  }
  const s = argv.indexOf('--span');
  return {
    from: BigInt(argv[i + 1]!),
    span: BigInt(s !== -1 && argv[s + 1] ? argv[s + 1]! : 50_000),
  };
}

async function main(): Promise<void> {
  const { from, span } = parseArgs(process.argv.slice(2));
  const { chainId } = loadEnv();
  const client = rpc();

  console.log(`[replay] chain ${chainId}: rewinding "${POOLS_STREAM}" cursor to ${from}`);
  await setCursor(chainId, POOLS_STREAM, from - 1n);

  const head = await client.getBlockNumber();
  for (;;) {
    const r = await pollOnce(client, { startAtHeadIfEmpty: false, maxSpan: span });
    console.log(
      `[replay] ${r.from}-${r.to}: ${r.poolsSeen} pools, ${r.launchesIndexed} new launches`,
    );
    const cur = await getCursor(chainId, POOLS_STREAM);
    if (cur === null || cur >= head - 2n) break;
    if (r.from === r.to && r.poolsSeen === 0) break;
  }

  console.log('[replay] caught up to head');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
