/**
 * One-off repair for the 2026-09-17 det_v0.1 enum incident (CHANGELOG.md).
 * These 20 launches got heuristic_v1/det_v0 persisted but not det_v0.1 or
 * their outcome-grid rows (the loop threw on det_v0.1 before reaching
 * ensureOutcomeRows). Re-running buildLaunchReports with the same
 * trigger='launch' reproduces the same deterministic block pin, so the
 * existing det_v0/heuristic_v1 rows upsert as a no-op (same reportHash) and
 * only the missing det_v0.1 row + outcome rows get created.
 *
 * pnpm --filter @launch-auditor/worker exec tsx src/scripts/backfill-det-v0-1-gap.ts
 */
import { PRIORITY, getBudgetedClient } from '@launch-auditor/rpc-budget';
import { loadEnv } from '../env';
import { buildLaunchReports, persistLaunchReports } from '../report';

const LAUNCH_IDS = [
  'cmu50phmu03zcql2ashz2ofbu',
  'cmu50phti03zeql2auyhjr1av',
  'cmu50prcw03zjql2adr5o7yev',
  'cmu50py2o03znql2a3fyqrypa',
  'cmu50q7mg040oql2acuzch06g',
  'cmu50q7qr040qql2au4d9aw9t',
  'cmu50r9kj041nql2a3rjy84va',
  'cmu50sif70447ql2awusb4lv9',
  'cmu50t1bm044iql2ahxdtwxd8',
  'cmu50t4kf044lql2atq50mrnb',
  'cmu50t7ti044oql2as5fb68v2',
  'cmu50tb3y0457ql2aholvuyvs',
  'cmu50thhc045bql2athc0k97n',
  'cmu50u0ff046fql2atz2i85ed',
  'cmu50u0jh046hql2aguo39m0s',
  'cmu50u0my046jql2azsufv5fw',
  'cmu50u3t8046mql2ase7opdtn',
  'cmu50u3vl046oql2adiojwlxv',
  'cmu50umsg0492ql2acheqllh7',
  'cmu50uq0g0495ql2a60dn9sv4',
];

async function main(): Promise<void> {
  const env = loadEnv();
  const client = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.backfill });

  let ok = 0;
  let failed = 0;
  for (const launchId of LAUNCH_IDS) {
    try {
      const drafts = await buildLaunchReports(client, launchId, 'launch');
      if (drafts.length === 0) {
        console.warn(`[gap-repair] ${launchId}: no drafts produced (missing features?)`);
        failed += 1;
        continue;
      }
      const r = await persistLaunchReports(drafts);
      console.log(`[gap-repair] ${launchId}: stored ${r.stored}, passed ${r.passed}, failed ${r.failed}`);
      ok += 1;
    } catch (err) {
      console.error(`[gap-repair] ${launchId}: threw`, err instanceof Error ? err.message : err);
      failed += 1;
    }
  }
  console.log(`[gap-repair] done: ${ok}/${LAUNCH_IDS.length} ok, ${failed} failed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[gap-repair] fatal', err);
    process.exit(1);
  },
);
