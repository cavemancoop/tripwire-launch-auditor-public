import { getBudgetedClient, PRIORITY } from '@launch-auditor/rpc-budget';
import type { PublicClient } from 'viem';
import { loadEnv } from '../env';

let client: PublicClient | undefined;

/**
 * The watcher's RPC client. Every call routes through the shared budget
 * (`@launch-auditor/rpc-budget`) at `watcher` priority — the highest — so keeping
 * up with the chain head always wins tokens over outcome resolution / backfill.
 */
export function rpc(): PublicClient {
  if (!client) {
    const { rpcUrl } = loadEnv();
    if (!rpcUrl) throw new Error('RH_RPC_URL is not set — the watcher needs an RPC for chain 4663');
    client = getBudgetedClient(rpcUrl, { priority: PRIORITY.watcher });
  }
  return client;
}
