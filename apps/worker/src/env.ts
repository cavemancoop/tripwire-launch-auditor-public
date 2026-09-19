import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WorkerEnv {
  chainId: number;
  rpcUrl: string;
  archiveRpcUrl: string;
  redisUrl: string;
  pollIntervalMs: number;
  quotaPerCreator24h: number;
  /** blocks behind head to treat as settled (reorg + load-balanced-RPC lag buffer) */
  headLagBlocks: bigint;
  /** max blocks advanced per poll, so a big catch-up is chunked with cursor saves */
  maxSpanBlocks: bigint;
  /** qualified lane (spec §3.1 / §12): min unique buyers in 10m to run scanners */
  qualifyUniqueBuyers: number;
  goplusApiKey?: string;
  scanhoodApiBase: string;
  /** signs EIP-712 report commitments (spec §6); the agent's public identity */
  agentPrivateKey?: `0x${string}`;
  gasWalletPrivateKey?: `0x${string}`;
  commitRegistryAddress?: `0x${string}`;
  commitIntervalSec: number;
  commitMaxLeaves: number;
  /** shared RPC budget: sustained requests/min across all callers (M4) */
  rpcBudgetRpm: number;
  /** eth_getLogs span: 0 = probe the RPC's real limit on boot, else use this */
  rpcMaxGetLogsRange: number;
  /** M5b Metabolism: hard reserve held back; STARVED when balance − this ≤ 0 */
  metabolismReserveUsd: number;
  /** balance below this (but above reserve) → DRAINING (still serving, flagged) */
  metabolismLowWaterUsd: number;
  /** key age ≥ this → hygiene ROTATING → create_key → ACTIVE */
  metabolismHygieneRotateDays: number;
  /** lifecycle poll cadence (spec §8: 60s) */
  metabolismStatusPollSec: number;
  /** |local ledger − orbio_get_balance.spent| rounding tolerance for the IDS check */
  metabolismIdsToleranceUsd: number;
  /** IDS settlement grace: absorbs ~one in-flight deep-dive not yet in the ledger */
  metabolismIdsGraceUsd: number;
  /** M5c: |provider − estimate| / estimate above this % is an epoch anomaly (pause, not revoke) */
  metabolismAnomalyPct: number;
  /** M5c: consecutive anomalous epochs before inference is paused */
  metabolismAnomalyEpochs: number;
  /** M5c: provider delta below this with zero requests is rounding noise, not phantom spend */
  metabolismPhantomToleranceUsd: number;
  /** M6 deep-dive — OpenRouter-shaped gateway base URL (Orbio) */
  orbioGatewayV1Url: string;
  /** pinned exact model slug for `llm_deepdive_v0` (no ~latest / openrouter/auto) */
  openrouterModelDeepdive: string;
  /** attribution: HTTP-Referer (dashboard URL) */
  openrouterHttpReferer: string;
  /** attribution: X-Title */
  openrouterXTitle: string;
  /** hard per-run compute cap for one deep-dive (spec §5: ≤ 0.20 USD) */
  deepdiveCapPerRunUsd: number;
  /** daily cap fed to the Metabolism budget policy */
  deepdiveDailyCapUsd: number;
  /** max tool-execution turns per deep-dive run */
  deepdiveMaxSteps: number;
  /** M8 free feed: unset disables the poster entirely (no channel to spam) */
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramPosterIntervalMs: number;
  /** public API base used in feed posts, so each links its own verifiable proof */
  publicApiBaseUrl?: string;
  /** M9 ops alerts: falls back to telegramChatId so one channel is enough */
  telegramAlertsChatId?: string;
  alertsIntervalMs: number;
  alertsCommitLagSec: number;
  alertsWatcherStalledSec: number;
  /** M9: the worker's own /health listener. Not read from bare $PORT — this
   *  project's .env already sets PORT=3000 for the api, and both processes
   *  load the same .env locally, so a bare $PORT fallback would collide. */
  healthPort: number;
}

let dotenvLoaded = false;

/**
 * Load the repo-root `.env` into `process.env`, once per process. Nothing here
 * was doing this before — every script just read `process.env` directly, which
 * only worked when whatever shell launched it happened to already have those
 * variables (a terminal profile, a prior `dotenv`-aware command, etc). That's
 * not something to depend on: a genuinely fresh shell, CI, or a differently
 * configured machine gets "RH_RPC_URL is not set" even with a real `.env` on
 * disk. `pnpm --filter` runs each script with cwd set to that package's own
 * directory, so walk up looking for `.env` rather than assuming the repo root.
 * Uses Node's built-in loader (stable since v20.12/v21.7), which — like
 * dotenv — never overrides a variable already set in the real environment
 * (so Railway/production env vars always win over any stray `.env`).
 */
function ensureDotenvLoaded(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // malformed .env — fall through and use whatever process.env already has
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function loadEnv(): WorkerEnv {
  ensureDotenvLoaded();
  const rpcUrl = process.env.RH_RPC_URL ?? '';
  return {
    chainId: Number(process.env.CHAIN_ID ?? 4663),
    rpcUrl,
    archiveRpcUrl: process.env.RH_RPC_ARCHIVE_URL || rpcUrl,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    pollIntervalMs: Number(process.env.WATCHER_POLL_INTERVAL_MS ?? 2000),
    quotaPerCreator24h: Number(process.env.QUOTA_PER_CREATOR_24H ?? 5),
    headLagBlocks: BigInt(process.env.WATCHER_HEAD_LAG_BLOCKS ?? 60),
    maxSpanBlocks: BigInt(process.env.WATCHER_MAX_SPAN_BLOCKS ?? 4000),
    qualifyUniqueBuyers: Number(process.env.QUALIFY_UNIQUE_BUYERS ?? 25),
    goplusApiKey: process.env.GOPLUS_API_KEY || undefined,
    scanhoodApiBase: process.env.SCANHOOD_API_BASE || 'https://scanhood.xyz',
    agentPrivateKey: normKey(process.env.AGENT_EIP712_PRIVATE_KEY),
    gasWalletPrivateKey: normKey(process.env.GAS_WALLET_PRIVATE_KEY),
    commitRegistryAddress: (process.env.COMMIT_REGISTRY_ADDRESS || undefined) as
      | `0x${string}`
      | undefined,
    commitIntervalSec: Number(process.env.COMMIT_INTERVAL_SEC ?? 300),
    commitMaxLeaves: Number(process.env.COMMIT_MAX_LEAVES ?? 200),
    rpcBudgetRpm: Number(process.env.RPC_BUDGET_RPM ?? 500),
    rpcMaxGetLogsRange: Number(process.env.RPC_MAX_GETLOGS_RANGE ?? 0),
    metabolismReserveUsd: Number(process.env.RESERVE_USD || 3),
    metabolismLowWaterUsd:
      Number(process.env.METABOLISM_LOW_WATER_USD || 0) ||
      Number(process.env.RESERVE_USD || 3) * 2,
    metabolismHygieneRotateDays: Number(process.env.METABOLISM_HYGIENE_ROTATE_DAYS || 7),
    metabolismStatusPollSec: Number(process.env.METABOLISM_STATUS_POLL_SEC || 60),
    metabolismIdsToleranceUsd: Number(process.env.METABOLISM_IDS_TOLERANCE_USD || 0.01),
    metabolismAnomalyPct: Number(process.env.METABOLISM_ANOMALY_PCT || 50),
    metabolismAnomalyEpochs: Number(process.env.METABOLISM_ANOMALY_EPOCHS || 3),
    metabolismPhantomToleranceUsd: Number(process.env.METABOLISM_PHANTOM_TOLERANCE_USD || 0.005),
    metabolismIdsGraceUsd: Number(
      process.env.METABOLISM_IDS_GRACE_USD ||
        Number(process.env.DEEPDIVE_CAP_PER_RUN_USD || 0.2) + 0.05,
    ),
    orbioGatewayV1Url: process.env.ORBIO_GATEWAY_V1_URL || 'https://api.orbio.so/api/v1',
    openrouterModelDeepdive: process.env.OPENROUTER_MODEL_DEEPDIVE || '',
    openrouterHttpReferer: process.env.OPENROUTER_HTTP_REFERER || '',
    openrouterXTitle: process.env.OPENROUTER_X_TITLE || 'Launch Auditor',
    deepdiveCapPerRunUsd: Number(process.env.DEEPDIVE_CAP_PER_RUN_USD || 0.2),
    deepdiveDailyCapUsd: Number(process.env.DEEPDIVE_DAILY_CAP_USD || 5),
    deepdiveMaxSteps: Number(process.env.DEEPDIVE_MAX_STEPS || 12),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHANNEL_ID || undefined,
    telegramPosterIntervalMs: Number(process.env.TELEGRAM_POSTER_INTERVAL_MS || 30_000),
    publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL || undefined,
    telegramAlertsChatId:
      process.env.TELEGRAM_ALERTS_CHANNEL_ID || process.env.TELEGRAM_CHANNEL_ID || undefined,
    alertsIntervalMs: Number(process.env.ALERTS_INTERVAL_MS || 60_000),
    alertsCommitLagSec: Number(process.env.ALERTS_COMMIT_LAG_SEC || 600),
    alertsWatcherStalledSec: Number(process.env.ALERTS_WATCHER_STALLED_SEC || 300),
    healthPort: Number(process.env.WORKER_PORT || 3010),
  };
}

function normKey(v: string | undefined): `0x${string}` | undefined {
  if (!v) return undefined;
  const k = v.startsWith('0x') ? v : `0x${v}`;
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as `0x${string}`) : undefined;
}
