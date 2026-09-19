import { prisma } from '@launch-auditor/db';

/** Stream name for the pool-creation cursor. */
export const POOLS_STREAM = 'pools';

export async function getCursor(chainId: number, stream: string): Promise<bigint | null> {
  const row = await prisma.watcherCursor.findUnique({
    where: { chainId_stream: { chainId, stream } },
  });
  return row ? row.lastBlock : null;
}

export async function setCursor(
  chainId: number,
  stream: string,
  lastBlock: bigint,
): Promise<void> {
  await prisma.watcherCursor.upsert({
    where: { chainId_stream: { chainId, stream } },
    create: { chainId, stream, lastBlock },
    update: { lastBlock },
  });
}
