import {
  POOL_EVENT_TOPIC0,
  getGetLogsMaxRange,
  poolCreationSources,
  setGetLogsMaxRange,
} from '@launch-auditor/chain';
import { getBudgetedClient, PRIORITY, probeGetLogsRange } from '@launch-auditor/rpc-budget';
import type { PublicClient } from 'viem';
import { runAlertLoop } from './alerts';
import { startAssessWorker } from './assess';
import { runCommitLoop } from './commit';
import { runDeepdiveLoop, startDeepdiveWorker } from './deepdive';
import { loadEnv, type WorkerEnv } from './env';
import { startHealthServer } from './health-server';
import { runLifecycleLoop } from './metabolism';
import { seedTokenStoreFromEnv } from './metabolism/session-seed';
import { deriveOrbioApiKey, describeKey } from './metabolism/credit-wallet';
import { setWalletGatewayKey } from './deepdive/openrouter';
import { runOutcomesLoop } from './outcomes';
import { runScorerLoop } from './scorer';
import { runTelegramPosterLoop } from './telegram/poster';
import { runPoller, type StopSignal } from './watcher/poller';
import { rpc } from './watcher/rpc';
import { startFeaturesWorker } from './watcher/t10';

/**
 * Establish the shared RPC budget before any scanning starts: log the rate, and
 * either pin the eth_getLogs span from env or probe the RPC's real limit once so
 * the watcher and (M4) backfill chunk at the largest size the node accepts.
 */
async function bootRpcBudget(client: PublicClient, env: WorkerEnv): Promise<void> {
  console.log(
    `[rpc-budget] ${env.rpcBudgetRpm} req/min shared · priority watcher>commit>outcomes>deepdive>backfill`,
  );
  if (env.rpcMaxGetLogsRange > 0) {
    setGetLogsMaxRange(env.rpcMaxGetLogsRange);
    console.log(`[rpc-budget] eth_getLogs span pinned to ${env.rpcMaxGetLogsRange} (env)`);
    return;
  }
  try {
    const head = await client.getBlockNumber();
    const { v4PoolManager } = poolCreationSources(env.chainId);
    const probe = probeGetLogsRange(
      (args) => client.request(args as never) as Promise<unknown>,
      {
        address: v4PoolManager,
        anchorBlock: head > 5n ? head - 5n : head,
        candidates: [9_999, 5_000, 2_000],
        topics: [POOL_EVENT_TOPIC0.v4Initialize], // sparse — keep the probe response small
      },
    );
    const timeout = new Promise<number>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 25_000));
    const span = await Promise.race([probe, timeout]);
    setGetLogsMaxRange(span);
    console.log(`[rpc-budget] probed eth_getLogs span = ${span} blocks`);
  } catch (err) {
    console.warn(
      `[rpc-budget] getLogs range probe failed; using config default ${getGetLogsMaxRange(env.chainId)} —`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function main(): Promise<void> {
  const client = rpc();
  const env = loadEnv();
  const signal: StopSignal = { stopped: false };

  // Before anything reads the token store: a container starts with no disk, so a
  // pushed Orbio session (railway:push-env --with-session) is written here.
  // Orbio on-chain (2026-09-16): the agent's API key is its wallet's signature.
  if (process.env.ORBIO_KEY_SOURCE?.trim().toLowerCase() === 'wallet') {
    if (!env.gasWalletPrivateKey) {
      console.warn('[metabolism] ORBIO_KEY_SOURCE=wallet but GAS_WALLET_PRIVATE_KEY is not set — keeping ORBIO_API_KEY');
    } else {
      const key = await deriveOrbioApiKey(env.gasWalletPrivateKey, Number(process.env.ORBIO_KEY_EPOCH || 0));
      setWalletGatewayKey(key);
      console.log(`[metabolism] gateway key from the gas wallet's signature: ${describeKey(key)}`);
    }
  }

  const seed = seedTokenStoreFromEnv();
  if (seed.seeded || process.env.ORBIO_SESSION_SEED) console.log(`[metabolism] session seed: ${seed.reason}`);

  await bootRpcBudget(client, env);

  const healthServer = startHealthServer(env.healthPort);

  const worker = startFeaturesWorker(client);
  worker.on('ready', () => console.log('[worker] features queue ready'));
  worker.on('error', (err) => console.error('[worker] error', err));

  const assessWorker = startAssessWorker(client);
  assessWorker.on('error', (err) => console.error('[assess] worker error', err));

  const shutdown = async (): Promise<void> => {
    signal.stopped = true;
    await Promise.all([worker.close(), assessWorker.close()]);
    healthServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (env.commitRegistryAddress && env.gasWalletPrivateKey) {
    console.log('[commit] loop enabled →', env.commitRegistryAddress);
    void runCommitLoop(signal);
  } else {
    console.log('[commit] loop disabled (COMMIT_REGISTRY_ADDRESS / GAS_WALLET_PRIVATE_KEY not set)');
  }

  // Outcomes get their own client at PRIORITY.outcomes. Until 2026-09-16 every
  // loop shared the watcher-priority client, so raising resolver batch and
  // concurrency competed as an equal with T+10m report generation instead of
  // yielding to it (the documented order is watcher > commit > outcomes).
  void runOutcomesLoop(getBudgetedClient(env.rpcUrl, { priority: PRIORITY.outcomes }), signal);
  // BENCHMARK_FILE, if set, must be an absolute path (or shared-relative-to-cwd
  // path both processes agree on) — leave it unset and runScorerLoop anchors to
  // the repo root, which is what the API's default also anchors to.
  void runScorerLoop(signal, { outFile: process.env.BENCHMARK_FILE || undefined });

  if (env.agentPrivateKey && process.env.TOKEN_ENCRYPTION_KEY) {
    console.log('[metabolism] lifecycle loop enabled');
    void runLifecycleLoop(signal);
  } else {
    console.log(
      '[metabolism] lifecycle loop disabled (AGENT_EIP712_PRIVATE_KEY / TOKEN_ENCRYPTION_KEY not set)',
    );
  }

  if (env.openrouterModelDeepdive && env.agentPrivateKey) {
    console.log(`[deepdive] enabled — model ${env.openrouterModelDeepdive}`);
    const ddWorker = startDeepdiveWorker();
    ddWorker.on('error', (err) => console.error('[deepdive] worker error', err));
    void runDeepdiveLoop(signal);
  } else {
    console.log('[deepdive] disabled (OPENROUTER_MODEL_DEEPDIVE / AGENT_EIP712_PRIVATE_KEY not set)');
  }

  if (env.telegramBotToken && env.telegramChatId) {
    console.log('[telegram] free-feed poster enabled ->', env.telegramChatId);
    void runTelegramPosterLoop(signal, {
      botToken: env.telegramBotToken,
      chatId: env.telegramChatId,
      chainId: env.chainId,
      apiBase: env.publicApiBaseUrl,
      intervalMs: env.telegramPosterIntervalMs,
    });
  } else {
    console.log('[telegram] free-feed poster disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set)');
  }

  if (env.telegramBotToken && env.telegramAlertsChatId) {
    console.log('[alerts] operational alerts enabled ->', env.telegramAlertsChatId);
    void runAlertLoop(signal, {
      botToken: env.telegramBotToken,
      chatId: env.telegramAlertsChatId,
      intervalMs: env.alertsIntervalMs,
      commitLagSec: env.alertsCommitLagSec,
      watcherStalledSec: env.alertsWatcherStalledSec,
    });
  } else {
    console.log('[alerts] operational alerts disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set)');
  }

  console.log('[watcher] starting pool-creation poller for chain', client.chain?.id ?? '(env)');
  await runPoller(client, signal);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
