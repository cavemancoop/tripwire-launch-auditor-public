import { getChainConfig } from '@launch-auditor/chain';
import { Prisma, prisma } from '@launch-auditor/db';
import { loadEnv } from '../env';

// pnpm watcher:recent [n]                      last n launches (default 10)
// pnpm watcher:recent <fromBlock>-<toBlock>     launches in that block range —
//                                               paste straight from a [watcher] log line
// pnpm watcher:recent --from <b> --to <b>       same, as explicit flags
//
// Prints Blockscout links for each launch, so a row can be checked against
// on-chain reality by hand.

interface ParsedArgs {
  where: Prisma.LaunchWhereInput;
  take?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const fromIdx = argv.indexOf('--from');
  const toIdx = argv.indexOf('--to');
  if (fromIdx !== -1 || toIdx !== -1) {
    const gte = fromIdx !== -1 ? BigInt(argv[fromIdx + 1]!) : undefined;
    const lte = toIdx !== -1 ? BigInt(argv[toIdx + 1]!) : undefined;
    return { where: { launchBlock: { gte, lte } } };
  }

  const positional = argv.find((a) => !a.startsWith('--'));
  if (positional) {
    const range = positional.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      return {
        where: { launchBlock: { gte: BigInt(range[1]!), lte: BigInt(range[2]!) } },
      };
    }
    if (/^\d+$/.test(positional)) return { where: {}, take: Number(positional) };
    throw new Error(
      `unrecognised argument "${positional}" — pass a count (10) or a block range (54300459-54300499)`,
    );
  }

  return { where: {}, take: 10 };
}

async function main(): Promise<void> {
  const { where, take } = parseArgs(process.argv.slice(2));
  const { chainId } = loadEnv();
  const explorer = getChainConfig(chainId).explorer;

  const rows = await prisma.launch.findMany({
    where: { chainId, ...where },
    orderBy: { launchBlock: 'desc' },
    ...(take ? { take } : {}),
    include: { feature: true },
  });

  if (rows.length === 0) {
    console.log('no launches match — let `pnpm dev:worker` run a little longer, or widen the range');
    return;
  }

  for (const l of rows) {
    const f = l.feature;
    console.log('─'.repeat(72));
    console.log(`token    ${l.tokenAddress}   (${l.source}, conf ${l.sourceConfidence ?? '—'})`);
    console.log(
      `pool     ${l.poolKind ?? '?'}  ${l.poolAddress ?? l.poolId ?? '—'}   via ${l.detectedVia ?? '—'}`,
    );
    console.log(`creator  ${l.creatorAddress}${l.quotaExceeded ? '   [quota exceeded]' : ''}`);
    console.log(
      `block    ${l.launchBlock.toString()}   ${l.launchAt?.toISOString() ?? '—'}   quote ${l.quoteAddress ?? '—'}`,
    );
    console.log(
      `features devbuy=${f?.creatorDevbuyPct ?? '—'}%  buyers10m=${f?.uniqueBuyers10m ?? '—'}  buysPerBuyer=${
        f?.buysPerBuyer10m?.toFixed(2) ?? '—'
      }  t10=${f?.t10ComputedAt ? 'done' : 'pending'}`,
    );
    console.log(`  tx     ${explorer}/tx/${l.launchTxHash}`);
    console.log(`  token  ${explorer}/token/${l.tokenAddress}`);
    console.log(`  maker  ${explorer}/address/${l.creatorAddress}`);
  }
  console.log('─'.repeat(72));
  console.log(`${rows.length} shown of ${await prisma.launch.count({ where: { chainId } })} total`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
