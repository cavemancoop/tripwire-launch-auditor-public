import { prisma } from '@launch-auditor/db';

async function main() {
  const label = process.argv[2] ?? 'DRAWDOWN_80';
  const rows = await prisma.outcome.findMany({
    where: { status: 'UNRESOLVABLE', label: label as never },
    orderBy: { measuredAt: 'desc' },
    take: 12,
    select: { horizon: true, tokenAddress: true, evidence: true, coverage: true },
  });
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const ev = (r.evidence ?? {}) as Record<string, unknown>;
    const reason = String(ev.reason ?? '(no reason)');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  // eslint-disable-next-line no-console
  console.log(`last 12 UNRESOLVABLE ${label}:`);
  for (const [k, v] of reasons) console.log(`  ${v}×  ${k}`);
  // eslint-disable-next-line no-console
  console.log('\nsample row:', JSON.stringify(rows[0], null, 2));

  // whole-population reason tally
  const all = await prisma.outcome.findMany({
    where: { status: 'UNRESOLVABLE', label: label as never },
    select: { evidence: true },
  });
  const tally = new Map<string, number>();
  for (const r of all) {
    const ev = (r.evidence ?? {}) as Record<string, unknown>;
    let reason = String(ev.reason ?? '(no reason)');
    reason = reason.replace(/0x[0-9a-fA-F]{6,}/g, '0x…').replace(/\d{4,}/g, 'N').slice(0, 90);
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  // eslint-disable-next-line no-console
  console.log(`\nall ${all.length} UNRESOLVABLE ${label} by reason:`);
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
