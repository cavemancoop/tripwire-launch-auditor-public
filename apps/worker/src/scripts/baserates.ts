import { prisma } from '@launch-auditor/db';

// logit with the same clamp the scoring package uses
const logit = (p: number): number => {
  const c = Math.min(1 - 1e-4, Math.max(1e-4, p));
  return Math.log(c / (1 - c));
};

async function table(qualifiedLaneOnly: boolean) {
  const resolved = await prisma.outcome.findMany({
    where: {
      status: 'RESOLVED',
      value: { not: null },
      retrospective: true,
      ...(qualifiedLaneOnly ? { launch: { lane: 'qualified' } } : {}),
    },
    select: { label: true, horizon: true, value: true },
  });
  const unres = await prisma.outcome.groupBy({
    by: ['label', 'horizon'],
    where: {
      status: 'UNRESOLVABLE',
      retrospective: true,
      ...(qualifiedLaneOnly ? { launch: { lane: 'qualified' } } : {}),
    },
    _count: { _all: true },
  });
  const unresMap = new Map(unres.map((u) => [`${u.label}@${u.horizon}`, u._count._all]));

  const acc = new Map<string, { n: number; pos: number }>();
  for (const r of resolved) {
    const k = `${r.label}@${r.horizon}`;
    const a = acc.get(k) ?? { n: 0, pos: 0 };
    a.n++;
    if (r.value) a.pos++;
    acc.set(k, a);
  }

  console.log(`\n=== base rates — ${qualifiedLaneOnly ? 'QUALIFIED LANE ONLY' : 'all retrospective'} ===`);
  console.log('cell                    n   pos    rate     logit   (unresolvable)');
  for (const [k, a] of [...acc.entries()].sort()) {
    const rate = a.n ? a.pos / a.n : 0;
    console.log(
      `${k.padEnd(22)} ${String(a.n).padStart(3)}  ${String(a.pos).padStart(4)}  ${rate
        .toFixed(4)
        .padStart(7)}  ${logit(rate).toFixed(3).padStart(7)}   (${unresMap.get(k) ?? 0})`,
    );
  }
}

async function main() {
  await table(true);
  await table(false);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
