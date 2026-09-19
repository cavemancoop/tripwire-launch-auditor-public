import { prisma } from '@launch-auditor/db';

// known real quote assets on 4663
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'; // <- appears as quote on NVDA; confirm
const NATIVE = '0x0000000000000000000000000000000000000000';

async function main() {
  const rows = await prisma.launch.findMany({
    where: { retrospective: true },
    select: { quoteAddress: true, poolFee: true, lane: true, poolKind: true },
  });
  const q = new Map<string, number>();
  const fee = new Map<string, number>();
  let qualified = 0;
  let weirdFee = 0;
  let unknownQuote = 0;
  const known = new Set([USDG, WETH, NATIVE]);
  for (const r of rows) {
    const qa = (r.quoteAddress ?? '(null)').toLowerCase();
    q.set(qa, (q.get(qa) ?? 0) + 1);
    const f = r.poolFee ?? -1;
    const fk = f < 0 ? '(null)' : f >= 100000 ? '>=10%' : f >= 30000 ? '3-10%' : f >= 10000 ? '1-3%' : '<1%';
    fee.set(fk, (fee.get(fk) ?? 0) + 1);
    if (r.lane === 'qualified') qualified++;
    if (f >= 100000) weirdFee++;
    if (!known.has(qa)) unknownQuote++;
  }
  // eslint-disable-next-line no-console
  console.log(`retrospective launches: ${rows.length} (qualified ${qualified})`);
  console.log(`  fee >= 10% (spam side-pool signal): ${weirdFee}`);
  console.log(`  quoteAddress not in {USDG,WETH,native}: ${unknownQuote}`);
  console.log('\nby quoteAddress:');
  for (const [k, v] of [...q.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(v).padStart(4)}  ${k}${known.has(k) ? '  <-known' : ''}`);
  }
  console.log('\nby poolFee bucket:');
  for (const [k, v] of [...fee.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
