import { COMMIT_REGISTRY_ABI, getWalletClient } from '@launch-auditor/chain';
import { Prisma, prisma } from '@launch-auditor/db';
import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import { decodeEventLog, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { loadEnv, type WorkerEnv } from '../env';
import { recordFailure } from '../failures';
import {
  ARTIFACT_KIND,
  ARTIFACT_KIND_BY_LABEL,
  computeArtifactHashes,
  type ArtifactHashes,
} from './artifacts';
import { buildMerkleTree } from './merkle';

/**
 * Chain 4663 mines in ~1s, but a load-balanced RPC (Chainstack) serves the first
 * `eth_getTransactionReceipt` calls from nodes that haven't seen the tx yet —
 * viem's `waitForTransactionReceipt` then throws (TransactionReceiptNotFound /
 * "Timed out ... to be confirmed") even though the tx has mined. Poll
 * `getTransactionReceipt` ourselves, swallowing not-found, until a wall-clock
 * deadline.
 */
async function waitReceipt(
  pub: PublicClient,
  hash: Hex,
  { deadlineMs = 240_000, intervalMs = 2_000 } = {},
): Promise<TransactionReceipt> {
  const deadline = Date.now() + deadlineMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      if (r) return r;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/could not be found|not be processed|not found|receipt/i.test(msg)) throw err;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(
    `receipt for ${hash} not found within ${deadlineMs}ms (tx likely mined — check the explorer)` +
      (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
  );
}

export interface CommitResult {
  committed: boolean;
  batchId?: number;
  root?: Hex;
  leafCount?: number;
  txHash?: Hex;
  reason?: string;
}

function requireCommitEnv(env: WorkerEnv):
  | { ok: true; pk: Hex; registry: Hex }
  | { ok: false; reason: string } {
  if (!env.gasWalletPrivateKey) return { ok: false, reason: 'GAS_WALLET_PRIVATE_KEY not set' };
  if (!env.commitRegistryAddress) return { ok: false, reason: 'COMMIT_REGISTRY_ADDRESS not set' };
  return { ok: true, pk: env.gasWalletPrivateKey, registry: env.commitRegistryAddress };
}

/** One-time: commit the frozen weights / feature-code / outcome-rule hashes. */
export async function ensureArtifactsCommitted(): Promise<{ committed: number }> {
  const env = loadEnv();
  const cfg = requireCommitEnv(env);
  if (!cfg.ok) return { committed: 0 };
  if (await prisma.commit.findFirst({ where: { kind: 'ARTIFACT' } })) return { committed: 0 };

  const h = computeArtifactHashes();
  const wallet = getWalletClient(env.rpcUrl, cfg.pk);
  const pub = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit });
  const items: { label: string; kind: Hex; hash: Hex; column: 'weightHash' | 'featureCodeHash' | 'outcomeRuleHash' }[] = [
    { label: 'weights', kind: ARTIFACT_KIND.weights, hash: h.weights, column: 'weightHash' },
    { label: 'feature_code', kind: ARTIFACT_KIND.featureCode, hash: h.featureCode, column: 'featureCodeHash' },
    { label: 'outcome_rule', kind: ARTIFACT_KIND.outcomeRule, hash: h.outcomeRule, column: 'outcomeRuleHash' },
  ];

  let committed = 0;
  for (const it of items) {
    const txHash = await wallet.writeContract({
      address: cfg.registry,
      abi: COMMIT_REGISTRY_ABI,
      functionName: 'commitArtifact',
      args: [it.kind, it.hash],
      account: wallet.account!,
      chain: wallet.chain,
    });
    const receipt = await waitReceipt(pub, txHash);
    const base = {
      kind: 'ARTIFACT' as const,
      chainId: env.chainId,
      merkleRoot: it.hash,
      leafCount: 0,
      txHash,
      blockNumber: receipt.blockNumber,
      committedAt: new Date(),
    };
    await prisma.commit.create({
      data:
        it.column === 'weightHash'
          ? { ...base, weightHash: it.hash }
          : it.column === 'featureCodeHash'
            ? { ...base, featureCodeHash: it.hash }
            : { ...base, outcomeRuleHash: it.hash },
    });
    committed += 1;
    // eslint-disable-next-line no-console
    console.log(`[commit] artifact ${it.label} ${it.hash} -> ${txHash}`);
  }
  return { committed };
}

/**
 * Merkle-batch the validated, uncommitted report hashes and post the root
 * on-chain (spec §6): every `commit.intervalSec` or `commit.maxLeaves` leaves.
 */
export async function runCommitJob(opts: { force?: boolean } = {}): Promise<CommitResult> {
  const env = loadEnv();
  const cfg = requireCommitEnv(env);
  if (!cfg.ok) return { committed: false, reason: cfg.reason };

  await ensureArtifactsCommitted();
  return runCommitBatch(opts);
}

const ARTIFACT_COLUMN: Partial<Record<keyof ArtifactHashes, 'weightHash' | 'featureCodeHash' | 'outcomeRuleHash' | 'scorerHash'>> = {
  weights: 'weightHash',
  featureCode: 'featureCodeHash',
  outcomeRule: 'outcomeRuleHash',
  scorerCode: 'scorerHash',
};

/**
 * Re-post every artifact hash whose file has changed since its last on-chain
 * `ArtifactCommitted` (spec §1.1 — a change is effective from its commit block).
 * Covers the M4c–M4e artifacts the one-time `ensureArtifactsCommitted` never
 * re-emits: the updated det_v0 weights + outcome rules + feature-code manifest,
 * the new forecaster maps, the scorer code, and det_v0.1's weights.
 */
export async function recommitArtifacts(
  opts: { force?: boolean } = {},
): Promise<{ committed: string[]; skipped: string[]; reason?: string }> {
  const env = loadEnv();
  const cfg = requireCommitEnv(env);
  if (!cfg.ok) return { committed: [], skipped: [], reason: cfg.reason };

  const hashes = computeArtifactHashes();
  const prior = await prisma.commit.findMany({
    where: { kind: 'ARTIFACT' },
    orderBy: { createdAt: 'asc' },
  });
  const last = new Map<string, string>();
  for (const r of prior) {
    const lv = r.leaves as { artifactLabel?: string; hash?: string } | null;
    if (lv && typeof lv === 'object' && lv.artifactLabel) {
      last.set(lv.artifactLabel, String(lv.hash ?? r.merkleRoot).toLowerCase());
    } else {
      if (r.weightHash) last.set('weights', r.weightHash.toLowerCase());
      if (r.featureCodeHash) last.set('featureCode', r.featureCodeHash.toLowerCase());
      if (r.outcomeRuleHash) last.set('outcomeRule', r.outcomeRuleHash.toLowerCase());
      if (r.scorerHash) last.set('scorerCode', r.scorerHash.toLowerCase());
    }
  }

  const wallet = getWalletClient(env.rpcUrl, cfg.pk);
  const pub = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit });
  const committed: string[] = [];
  const skipped: string[] = [];

  for (const [label, hash] of Object.entries(hashes) as [keyof ArtifactHashes, Hex][]) {
    if (!opts.force && last.get(label) === hash.toLowerCase()) {
      skipped.push(label);
      continue;
    }
    const txHash = await wallet.writeContract({
      address: cfg.registry,
      abi: COMMIT_REGISTRY_ABI,
      functionName: 'commitArtifact',
      args: [ARTIFACT_KIND_BY_LABEL[label], hash],
      account: wallet.account!,
      chain: wallet.chain,
    });
    const receipt = await waitReceipt(pub, txHash);
    const col = ARTIFACT_COLUMN[label];
    await prisma.commit.create({
      data: {
        kind: 'ARTIFACT',
        chainId: env.chainId,
        merkleRoot: hash,
        leafCount: 0,
        txHash,
        blockNumber: receipt.blockNumber,
        committedAt: new Date(),
        leaves: { artifactLabel: label, hash } as Prisma.InputJsonValue,
        ...(col ? { [col]: hash } : {}),
      },
    });
    committed.push(`${label} ${hash} -> ${txHash}`);
    // eslint-disable-next-line no-console
    console.log(`[commit] artifact ${label} ${hash} -> ${txHash}`);
  }
  return { committed, skipped };
}

type PendingReport = { id: string; reportHash: string; createdAt: Date };

/**
 * A batch whose tx was sent but whose receipt never showed up inside
 * `waitReceipt`'s deadline. Seen in production 2026-09-15: every such tx had
 * in fact mined successfully, but with no DB row its reports stayed
 * `commitId: null` and were re-anchored in the next batch — an orphan root
 * on-chain, extra gas, and a proof pointing at a later commit than the real one.
 * Held in memory (a restart falls back to the old re-commit behaviour).
 */
export interface UnconfirmedBatch {
  txHash: Hex;
  batch: PendingReport[];
  sentAt: number;
}

/** Give up on an unconfirmed tx after this long and let its reports re-commit. */
export const UNCONFIRMED_MAX_AGE_MS = 30 * 60_000;

export type UnconfirmedAction = 'finalize' | 'wait' | 'drop_reverted' | 'drop_expired';

/** Pure: what to do with a still-unconfirmed batch given this tick's receipt lookup. */
export function unconfirmedAction(
  u: Pick<UnconfirmedBatch, 'sentAt'>,
  receipt: Pick<TransactionReceipt, 'status'> | null,
  now: number,
  maxAgeMs = UNCONFIRMED_MAX_AGE_MS,
): UnconfirmedAction {
  if (receipt) return receipt.status === 'success' ? 'finalize' : 'drop_reverted';
  return now - u.sentAt >= maxAgeMs ? 'drop_expired' : 'wait';
}

let unconfirmed: UnconfirmedBatch | null = null;

async function runCommitBatch(opts: { force?: boolean }): Promise<CommitResult> {
  const env = loadEnv();
  const cfg = requireCommitEnv(env);
  if (!cfg.ok) return { committed: false, reason: cfg.reason };

  // A held batch is resolved first, but it never blocks the next one: its
  // reports are simply excluded from `pending` until it is recorded or dropped.
  // (Blocking cost ~30 min of commits per slow receipt on 2026-09-15.)
  let held: string[] = [];
  if (unconfirmed) {
    const u = unconfirmed;
    const pub = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit });
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await pub.getTransactionReceipt({ hash: u.txHash });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[commit] receipt check for ${u.txHash}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
    const action = unconfirmedAction(u, receipt, Date.now());
    if (action === 'wait') {
      held = u.batch.map((r) => r.id);
    } else {
      unconfirmed = null;
      if (action === 'finalize') {
        // eslint-disable-next-line no-console
        console.log(`[commit] late receipt for ${u.txHash} — recording its batch instead of re-committing`);
        return recordBatch(env, cfg.registry, u.batch, buildMerkleTree(u.batch.map((r) => r.reportHash as Hex)), u.txHash, receipt!);
      }
      // eslint-disable-next-line no-console
      console.warn(`[commit] dropping unconfirmed ${u.txHash} (${action}) — its reports will re-commit`);
    }
  }

  const pending = await prisma.report.findMany({
    where: { validatorPassed: true, commitId: null, ...(held.length ? { id: { notIn: held } } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, reportHash: true, createdAt: true },
  });
  if (pending.length === 0) return { committed: false, reason: 'nothing pending' };

  const oldestAgeSec = (Date.now() - pending[0]!.createdAt.getTime()) / 1000;
  const ready =
    opts.force ||
    pending.length >= env.commitMaxLeaves ||
    oldestAgeSec >= env.commitIntervalSec;
  if (!ready) {
    return {
      committed: false,
      reason: `waiting — ${pending.length}/${env.commitMaxLeaves} leaves, oldest ${Math.round(oldestAgeSec)}s/${env.commitIntervalSec}s`,
    };
  }

  const batch = pending.slice(0, env.commitMaxLeaves);
  const tree = buildMerkleTree(batch.map((r) => r.reportHash as Hex));

  const wallet = getWalletClient(env.rpcUrl, cfg.pk);
  const pub = getBudgetedClient(env.rpcUrl, { priority: PRIORITY.commit });
  const txHash = await wallet.writeContract({
    address: cfg.registry,
    abi: COMMIT_REGISTRY_ABI,
    functionName: 'commitBatch',
    args: [tree.root, BigInt(tree.leafCount)],
    account: wallet.account!,
    chain: wallet.chain,
  });
  const sentAt = Date.now();
  let receipt: TransactionReceipt;
  try {
    receipt = await waitReceipt(pub, txHash);
  } catch (err) {
    unconfirmed = { txHash, batch, sentAt };
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} — held as unconfirmed; its reports are excluded from later batches until it resolves`,
    );
  }
  if (receipt.status !== 'success') {
    return { committed: false, reason: `commitBatch tx reverted (${txHash})` };
  }
  return recordBatch(env, cfg.registry, batch, tree, txHash, receipt);
}

async function recordBatch(
  env: WorkerEnv,
  registry: Hex,
  batch: PendingReport[],
  tree: ReturnType<typeof buildMerkleTree>,
  txHash: Hex,
  receipt: TransactionReceipt,
): Promise<CommitResult> {
  let batchId: number | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: COMMIT_REGISTRY_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'BatchCommitted') batchId = Number(ev.args.batchId);
    } catch {
      /* not our event */
    }
  }

  const leavesJson = batch.map((r) => {
    const h = (r.reportHash as string).toLowerCase();
    return { reportHash: h, index: tree.leaves.indexOf(h as Hex), proof: tree.proofs.get(h) ?? [] };
  });

  const commit = await prisma.commit.create({
    data: {
      kind: 'REPORT_BATCH',
      chainId: env.chainId,
      merkleRoot: tree.root,
      leafCount: tree.leafCount,
      leaves: leavesJson as unknown as Prisma.InputJsonValue,
      txHash,
      blockNumber: receipt.blockNumber,
      committedAt: new Date(),
    },
  });

  await prisma.$transaction(
    batch.map((r) =>
      prisma.report.update({
        where: { id: r.id },
        data: { commitId: commit.id, merkleLeafHash: (r.reportHash as string).toLowerCase() },
      }),
    ),
  );

  // eslint-disable-next-line no-console
  console.log(`[commit] batch ${batchId} root ${tree.root} (${tree.leafCount} leaves) -> ${txHash}`);
  return { committed: true, batchId, root: tree.root, leafCount: tree.leafCount, txHash };
}

export interface StopSignal {
  stopped: boolean;
}

export async function runCommitLoop(signal: StopSignal): Promise<void> {
  const env = loadEnv();
  const tickMs = Math.min(env.commitIntervalSec, 60) * 1000;
  while (!signal.stopped) {
    try {
      const r = await runCommitJob();
      if (r.committed) {
        // logged inside runCommitJob
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[commit] loop error', err instanceof Error ? err.message : err);
      await recordFailure('commit.loop_error', err);
    }
    await new Promise((res) => setTimeout(res, tickMs));
  }
}
