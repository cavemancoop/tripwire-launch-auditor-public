/**
 * M10 — per-catch-site failure counters, surfaced on /metrics (packages/db
 * schema.prisma: CatchSiteFailure). Every long-running loop's catch block
 * already logs and continues by design (one bad launch/token shouldn't stop
 * a sweep) -- this makes that visible without tailing logs. Call alongside
 * the existing console.error/warn, never instead of it.
 *
 * Deliberately fails safe: a DB hiccup recording a failure must never mask
 * or throw over the original error it's recording.
 */
import { prisma } from '@launch-auditor/db';

export async function recordFailure(site: string, err: unknown): Promise<void> {
  // Every catch site that calls this is exercised by tests deliberately
  // forcing that failure path (e.g. "a send fails, is left unmarked, and the
  // sweep keeps going") — pnpm verify runs fully offline (CLAUDE.md), so a
  // real Prisma call here would burn ~4s per test hitting Postgres's refused
  // connection instead of failing outright. This is the one counter write
  // it's correct to skip, not paper over: nothing in a vitest run is a real
  // production incident.
  if (process.env.VITEST) return;

  const message = err instanceof Error ? err.message : String(err);
  try {
    await prisma.catchSiteFailure.upsert({
      where: { site },
      create: { site, count: 1, lastMessage: message },
      update: { count: { increment: 1 }, lastMessage: message },
    });
  } catch (recordErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[failures] could not record catch-site failure for "${site}"`,
      recordErr instanceof Error ? recordErr.message : recordErr,
    );
  }
}
