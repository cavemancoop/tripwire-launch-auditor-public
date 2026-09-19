import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export * from './lifecycle-chain';
export * from './deepdive-budget';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Process-wide singleton. Re-used across hot reloads in dev. */
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
