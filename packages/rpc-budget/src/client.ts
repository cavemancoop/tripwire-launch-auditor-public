import { RH_CHAIN_ID, robinhoodChain } from '@launch-auditor/chain';
import { createPublicClient, type PublicClient } from 'viem';
import { ResponseCache } from './cache';
import { resolveBudgetConfig } from './config';
import { RequestScheduler, type SchedulerStats } from './scheduler';
import { budgetedHttp } from './transport';

/** One scheduler + one cache per RPC URL, shared process-wide. */
const schedulers = new Map<string, RequestScheduler>();
const caches = new Map<string, ResponseCache>();

export function schedulerFor(rpcUrl: string): RequestScheduler {
  let s = schedulers.get(rpcUrl);
  if (!s) {
    const { rpm, maxInFlight, burst } = resolveBudgetConfig();
    s = new RequestScheduler({ rpm, maxInFlight, burst });
    schedulers.set(rpcUrl, s);
  }
  return s;
}

export function cacheFor(rpcUrl: string): ResponseCache {
  let c = caches.get(rpcUrl);
  if (!c) {
    c = new ResponseCache();
    caches.set(rpcUrl, c);
  }
  return c;
}

export interface BudgetedClientOptions {
  /** priority tier (see PRIORITY) */
  priority: number;
  chainId?: number;
  timeout?: number;
  /** set false to bypass the shared response cache for this client */
  cache?: boolean;
}

/**
 * A viem PublicClient whose every RPC call is rate-limited and de-duplicated
 * through the budget shared by all clients for the same `rpcUrl`. Drop-in for
 * `getPublicClient` from `@launch-auditor/chain`.
 */
export function getBudgetedClient(rpcUrl: string, opts: BudgetedClientOptions): PublicClient {
  if (!rpcUrl) throw new Error('getBudgetedClient: rpcUrl is empty (set RH_RPC_URL)');
  const chainId = opts.chainId ?? RH_CHAIN_ID;
  return createPublicClient({
    chain: robinhoodChain,
    transport: budgetedHttp(rpcUrl, {
      scheduler: schedulerFor(rpcUrl),
      cache: opts.cache === false ? undefined : cacheFor(rpcUrl),
      priority: opts.priority,
      chainId,
      timeout: opts.timeout,
    }),
  });
}

export interface BudgetSnapshot extends SchedulerStats {
  cacheHits: number;
  cacheMisses: number;
  cacheSize: number;
}

export function budgetStats(rpcUrl: string): BudgetSnapshot {
  const s = schedulerFor(rpcUrl).stats;
  const c = cacheFor(rpcUrl);
  return { ...s, cacheHits: c.hits, cacheMisses: c.misses, cacheSize: c.size };
}

/** Test hook: drop all schedulers/caches so config changes take effect. */
export function resetRpcBudget(): void {
  schedulers.clear();
  caches.clear();
}
