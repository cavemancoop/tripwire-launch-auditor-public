import { prisma } from '@launch-auditor/db';

/**
 * Put outcomes that were resolved BEFORE the M4 pipeline fixes back to PENDING
 * so the next backfill sweep re-resolves them correctly:
 *  - every SELL_IMPAIRED (the resolver posted reverts as `true`)
 *  - "no positive price in the reference window" UNRESOLVABLEs whose launch has
 *    since had its primary pool re-derived (they may have been on a decoy pool)
 * Pass --commit to apply; default is a dry run.
 */
async function main() {
  const commit = process.argv.includes('--commit');

  const sell = await prisma.outcome.findMany({
    where: { retrospective: true, label: 'SELL_IMPAIRED', status: { in: ['RESOLVED', 'UNRESOLVABLE'] } },
    select: { id: true },
  });

  const wrongPool = await prisma.outcome.findMany({
    where: {
      retrospective: true,
      status: 'UNRESOLVABLE',
      label: { in: ['DRAWDOWN_80', 'LIQ_IMPAIRED', 'TRADING_ALIVE'] },
      launch: { primaryPoolCheckedAt: { not: null } },
    },
    select: { id: true, evidence: true },
  });
  const wrongPoolIds = wrongPool
    .filter((o) => {
      const r = String((o.evidence as Record<string, unknown> | null)?.reason ?? '');
      return /no positive price|no swap|no ModifyLiquidity|empty window|series/i.test(r);
    })
    .map((o) => o.id);

  const ids = [...new Set([...sell.map((o) => o.id), ...wrongPoolIds])];
  console.log(`SELL_IMPAIRED to reset:        ${sell.length}`);
  console.log(`wrong-pool UNRESOLVABLE reset: ${wrongPoolIds.length}`);
  console.log(`total distinct:               ${ids.length}`);

  if (!commit) {
    console.log('\n(dry run — pass --commit to apply)');
    await prisma.$disconnect();
    return;
  }
  const r = await prisma.outcome.updateMany({
    where: { id: { in: ids } },
    data: { status: 'PENDING', value: null, measuredAt: null },
  });
  console.log(`\nreset ${r.count} outcomes to PENDING`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
