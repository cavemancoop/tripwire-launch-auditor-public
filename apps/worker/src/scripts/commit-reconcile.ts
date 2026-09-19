import { getLogsChunked } from '@launch-auditor/chain';
import { Prisma, prisma } from '@launch-auditor/db';
import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import { toEventSelector, type Hex } from 'viem';
import { ARTIFACT_KIND_BY_LABEL, computeArtifactHashes, type ArtifactHashes } from '../commit/artifacts';
import { loadEnv } from '../env';

/**
 * Reconcile the local `commit` table with on-chain `ArtifactCommitted` events.
 * `pnpm commit:run --artifacts` can send a tx that mines but then die on the
 * receipt wait (load-balanced RPC lag) before writing its DB row — after which
 * recommitArtifacts re-posts an artifact that is already current. This walks
 * back from head, finds the latest on-chain hash per artifact kind, and inserts
 * the missing DB row when it matches the current file hash. --commit to apply.
 */
// CommitRegistry.sol: event ArtifactCommitted(bytes32 indexed kind, bytes32 hash, uint256 timestamp)
const EVENT_SIG = toEventSelector('ArtifactCommitted(bytes32,bytes32,uint256)');
const ARTIFACT_COLUMN: Partial<Record<keyof ArtifactHashes, string>> = {
  weights: 'weightHash',
  featureCode: 'featureCodeHash',
  outcomeRule: 'outcomeRuleHash',
  scorerCode: 'scorerHash',
};

async function main() {
  const apply = process.argv.includes('--commit');
  const env = loadEnv();
  const registry = env.commitRegistryAddress as Hex;
  if (!registry) throw new Error('COMMIT_REGISTRY_ADDRESS not set');
  const client = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit });

  const head = await client.getBlockNumber();
  const files = computeArtifactHashes();

  const prior = await prisma.commit.findMany({ where: { kind: 'ARTIFACT' }, orderBy: { createdAt: 'asc' } });
  const dbHas = new Map<string, string>();
  for (const r of prior) {
    const lv = r.leaves as { artifactLabel?: string; hash?: string } | null;
    if (lv?.artifactLabel) dbHas.set(lv.artifactLabel, String(lv.hash ?? r.merkleRoot).toLowerCase());
    else {
      if (r.weightHash) dbHas.set('weights', r.weightHash.toLowerCase());
      if (r.featureCodeHash) dbHas.set('featureCode', r.featureCodeHash.toLowerCase());
      if (r.outcomeRuleHash) dbHas.set('outcomeRule', r.outcomeRuleHash.toLowerCase());
      if (r.scorerHash) dbHas.set('scorerCode', r.scorerHash.toLowerCase());
    }
  }

  const inserts: Prisma.CommitCreateManyInput[] = [];
  for (const [label, kind] of Object.entries(ARTIFACT_KIND_BY_LABEL) as [keyof ArtifactHashes, Hex][]) {
    // walk back from head in 10k windows until we see this kind's latest event
    let onChain: { hash: string; block: bigint; tx: string } | null = null;
    const floor = head > 800_000n ? head - 800_000n : 0n; // recent commits only
    for (let to = head; to > floor && !onChain; to -= 10_000n) {
      const from = to > floor + 9_999n ? to - 9_999n : floor;
      const logs = await getLogsChunked(client, {
        address: registry,
        topics: [EVENT_SIG as Hex, kind],
        fromBlock: from,
        toBlock: to,
        maxRange: 9_999,
      });
      if (logs.length) {
        const l = logs[logs.length - 1]!;
        onChain = { hash: `0x${l.data.slice(2, 66)}`, block: BigInt(l.blockNumber), tx: l.transactionHash };
      }
    }

    const fileHash = files[label].toLowerCase();
    const chainHash = onChain?.hash.toLowerCase() ?? null;
    const db = dbHas.get(label) ?? null;
    const status =
      chainHash === fileHash && db === fileHash
        ? 'ok'
        : chainHash === fileHash && db !== fileHash
          ? 'INSERT db row (on-chain, missing locally)'
          : chainHash !== fileHash
            ? 'stale on-chain — recommit needed'
            : '??';
    console.log(`${label.padEnd(20)} file=${fileHash.slice(0, 12)} chain=${(chainHash ?? 'none').slice(0, 12)} db=${(db ?? 'none').slice(0, 12)}  ${status}`);

    if (chainHash === fileHash && db !== fileHash && onChain) {
      const col = ARTIFACT_COLUMN[label];
      inserts.push({
        kind: 'ARTIFACT',
        chainId: env.chainId,
        merkleRoot: fileHash,
        leafCount: 0,
        txHash: onChain.tx,
        blockNumber: onChain.block,
        committedAt: new Date(),
        leaves: { artifactLabel: label, hash: fileHash } as Prisma.InputJsonValue,
        ...(col ? { [col]: fileHash } : {}),
      });
    }
  }

  if (inserts.length === 0) {
    console.log('\nnothing to reconcile.');
  } else if (!apply) {
    console.log(`\n${inserts.length} row(s) to insert — pass --commit to apply.`);
  } else {
    await prisma.commit.createMany({ data: inserts });
    console.log(`\ninserted ${inserts.length} commit row(s). Re-run pnpm commit:run --artifacts to post any still-stale.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
