import { prisma } from '@launch-auditor/db';

/**
 * One-shot DB status readout — launches, feature coverage, outcome inventory,
 * and whether anything is being resolved right now.
 *   pnpm --filter @launch-auditor/worker exec tsx src/scripts/inventory.ts
 */
async function main() {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 60_000);

  const [launches, featured, retro, retroFeatured] = await Promise.all([
    prisma.launch.count(),
    prisma.feature.count({ where: { t10ComputedAt: { not: null } } }),
    prisma.launch.count({ where: { retrospective: true } }),
    prisma.launch.count({
      where: { retrospective: true, feature: { t10ComputedAt: { not: null } } },
    }),
  ]);

  const byStatus = await prisma.outcome.groupBy({ by: ['status'], _count: { _all: true } });
  const duePending = await prisma.outcome.count({
    where: { status: 'PENDING', horizonAt: { lte: now } },
  });
  const resolved = await prisma.outcome.groupBy({
    by: ['label', 'horizon', 'value'],
    where: { status: 'RESOLVED' },
    _count: { _all: true },
  });

  const touchedRecently = await prisma.outcome.count({ where: { measuredAt: { gte: since } } });
  const lastMeasured = await prisma.outcome.findFirst({
    where: { measuredAt: { not: null } },
    orderBy: { measuredAt: 'desc' },
    select: { measuredAt: true, label: true, horizon: true, status: true },
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        now: now.toISOString(),
        launches,
        featuredT10: featured,
        retrospective: retro,
        retrospectiveFeatured: retroFeatured,
        outcomeByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        pendingHorizonPassed: duePending,
        resolvedCells: resolved
          .map((r) => ({ cell: `${r.label}@${r.horizon}`, value: r.value, n: r._count._all }))
          .sort((a, b) => a.cell.localeCompare(b.cell)),
        activity: {
          outcomesTouchedLast30min: touchedRecently,
          mostRecentlyMeasured: lastMeasured,
        },
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
