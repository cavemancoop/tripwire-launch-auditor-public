import { COMMIT_REGISTRY_ABI } from '@launch-auditor/chain';
import { prisma } from '@launch-auditor/db';
import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import { parseAbiItem, type Hex } from 'viem';
import { verifyProof } from '../commit/merkle';
import { loadEnv } from '../env';

// pnpm commit:verify <reportHash>
//   Verify a report's stored Merkle proof against its batch root, and confirm
//   that root was committed on-chain (BatchCommitted event). This is what
//   GET /v1/proof/<hash> (M7) will do over HTTP.

interface StoredLeaf {
  reportHash: string;
  index: number;
  proof: string[];
}

async function main(): Promise<void> {
  const target = (process.argv[2] ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(target)) {
    throw new Error('usage: pnpm commit:verify <0x… 32-byte reportHash>');
  }

  const report = await prisma.report.findUnique({
    where: { reportHash: target },
    include: { commit: true },
  });
  if (!report) throw new Error(`no report with hash ${target}`);
  if (!report.commit) {
    console.log(JSON.stringify({ reportHash: target, committed: false }, null, 2));
    return;
  }

  const commit = report.commit;
  const leaves = (commit.leaves as unknown as StoredLeaf[]) ?? [];
  const leaf = leaves.find((l) => l.reportHash.toLowerCase() === target);
  if (!leaf) throw new Error('commit has no stored proof for this report');

  const proofOk = verifyProof(
    target as Hex,
    leaf.proof as Hex[],
    commit.merkleRoot as Hex,
  );

  const env = loadEnv();
  let onChain = false;
  if (env.commitRegistryAddress && commit.blockNumber !== null) {
    const client = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit });
    const logs = await client.getLogs({
      address: env.commitRegistryAddress,
      event: parseAbiItem(
        'event BatchCommitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 leafCount, uint256 timestamp)',
      ),
      fromBlock: commit.blockNumber,
      toBlock: commit.blockNumber,
    });
    onChain = logs.some(
      (l) => (l.args.merkleRoot as string)?.toLowerCase() === commit.merkleRoot.toLowerCase(),
    );
  }

  console.log(
    JSON.stringify(
      {
        reportHash: target,
        forecaster: report.forecaster,
        committed: true,
        merkleRoot: commit.merkleRoot,
        leafIndex: leaf.index,
        proofLength: leaf.proof.length,
        proofVerifiesLocally: proofOk,
        rootCommittedOnChain: onChain,
        txHash: commit.txHash,
        blockNumber: commit.blockNumber ? Number(commit.blockNumber) : null,
      },
      null,
      2,
    ),
  );
  if (!proofOk || !onChain) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
