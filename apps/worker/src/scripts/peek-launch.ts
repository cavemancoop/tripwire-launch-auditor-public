import { prisma } from '@launch-auditor/db';

async function main() {
  const token = (process.argv[2] ?? '').toLowerCase();
  const l = await prisma.launch.findFirst({
    where: { tokenAddress: token },
    include: { feature: true },
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(l, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
