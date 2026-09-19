/**
 * M7 — apps/api's own env loader. Deliberately small: the API only ever reads
 * (Prisma) or does light, occasional read-only RPC (the proof endpoint's
 * on-chain confirmation) — it never signs, commits, or spends. No secret keys
 * belong here.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Walk up from `startDir` for the workspace root. `pnpm --filter X start` sets
 * cwd to that package's own directory, so a bare relative default like
 * `data/benchmark.json` would resolve differently in the API than in the
 * worker that writes it (`apps/worker/src/scorer/loop.ts` has the same
 * helper, duplicated rather than shared across an app/app boundary).
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export interface ApiEnv {
  rpcUrl: string;
  chainId: number;
  commitRegistryAddress?: `0x${string}`;
  /** comma-separated keys that identify a design partner (spec §9) */
  designPartnerApiKeys: string[];
  /** where the worker's periodic scorer writes the benchmark snapshot (M7) */
  benchmarkFile: string;
  revenueAddress?: `0x${string}`;
  priceDeepdiveUsdg: number;
  /** M8 dashboard — display-only mirror of the worker's live deep-dive budget
   *  gate (apps/worker/src/metabolism/budget.ts), duplicated rather than
   *  imported across the app boundary (same treatment as merkle.ts). Reads
   *  the same env vars so it never drifts from what actually governs spend. */
  deepdiveDailyCapUsd: number;
  deepdiveCapPerRunUsd: number;
  metabolismReserveUsd: number;
  /** 2026-09-16 — the agent's Orbio account (public address) and the CREDIT
   *  token, for `GET /v1/funding`. All three unset = endpoint reports unconfigured. */
  orbioAgentAccount?: `0x${string}`;
  orbioCreditAddress?: `0x${string}`;
  fundingFromBlock?: number;
}

export function loadApiEnv(): ApiEnv {
  return {
    rpcUrl: process.env.RH_RPC_URL ?? '',
    chainId: Number(process.env.CHAIN_ID || 4663),
    commitRegistryAddress: (process.env.COMMIT_REGISTRY_ADDRESS || undefined) as
      | `0x${string}`
      | undefined,
    designPartnerApiKeys: (process.env.DESIGN_PARTNER_API_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    benchmarkFile:
      process.env.BENCHMARK_FILE || join(findRepoRoot(process.cwd()), 'data', 'benchmark.json'),
    revenueAddress: (process.env.REVENUE_ADDRESS || undefined) as `0x${string}` | undefined,
    priceDeepdiveUsdg: Number(process.env.PRICE_DEEPDIVE_USDG || 0.1),
    deepdiveDailyCapUsd: Number(process.env.DEEPDIVE_DAILY_CAP_USD || 5),
    deepdiveCapPerRunUsd: Number(process.env.DEEPDIVE_CAP_PER_RUN_USD || 0.2),
    metabolismReserveUsd: Number(process.env.RESERVE_USD || 3),
    orbioAgentAccount: (process.env.ORBIO_AGENT_ACCOUNT || undefined) as `0x${string}` | undefined,
    orbioCreditAddress: (process.env.ORBIO_CREDIT_ADDRESS || undefined) as `0x${string}` | undefined,
    fundingFromBlock: process.env.ORBIO_FUNDING_FROM_BLOCK ? Number(process.env.ORBIO_FUNDING_FROM_BLOCK) : undefined,
  };
}
