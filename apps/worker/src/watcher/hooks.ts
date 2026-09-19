import {
  decodeHookPermissions,
  getChainConfig,
  getLogsByTopicValues,
  getLogsChunked,
  hookRisk,
  POOL_EVENT_TOPIC0,
} from '@launch-auditor/chain';
import type { Hex } from 'viem';
import { APPROVAL_TOPIC0, addressToTopic, topicToAddress } from './erc20';
import { withRetry } from './retry';

// M4e — the v4 hook / side-pool / approval surface. A hook's permissions are in
// the low 14 bits of its address (zero RPC). Side pools and drainer approvals
// need a bounded getLogs each.

export interface HookFeatures {
  hookPermissions: number | null;
  hookCanBlockSwap: boolean | null;
  hookCanTaxSwap: boolean | null;
  hookGatesLpRemoval: boolean | null;
}

/** Pure — from `Launch.poolHooks`. null hooks address => a clean (hookless) pool. */
export function computeHookFeatures(poolHooks: string | null | undefined): HookFeatures {
  const perms = decodeHookPermissions(poolHooks);
  if (!perms.hasHook) {
    return {
      hookPermissions: 0,
      hookCanBlockSwap: false,
      hookCanTaxSwap: false,
      hookGatesLpRemoval: false,
    };
  }
  const risk = hookRisk(perms);
  return {
    hookPermissions: perms.flags,
    hookCanBlockSwap: risk.canBlockSwap,
    hookCanTaxSwap: risk.canTaxSwap,
    hookGatesLpRemoval: risk.gatesLpRemoval,
  };
}

const lc = (s: string): string => s.toLowerCase();

/** Config addresses that are infrastructure, not a "drainer" spender / side pool. */
export function infraAddresses(chainId: number): Set<string> {
  const cfg = getChainConfig(chainId);
  const set = new Set<string>([
    lc(cfg.uniswap.v4PoolManager.address),
    lc(cfg.uniswap.v3Factory.address),
    lc(cfg.uniswap.v2Factory.address),
    lc(cfg.uniswap.v4Quoter.address),
    '0x0000000000000000000000000000000000000000',
  ]);
  for (const a of cfg.uniswap.v3Factory.alternates ?? []) set.add(lc(a));
  for (const lp of cfg.launchpads) {
    for (const f of lp.factories) set.add(lc(f));
    for (const f of lp.candidateFactories ?? []) set.add(lc(f));
    for (const e of (lp as { entrypoints?: string[] }).entrypoints ?? []) set.add(lc(e));
  }
  return set;
}

type LogClient = Parameters<typeof getLogsChunked>[0];

/** v4 pools (other than the primary) where `token` holds a currency slot. */
export async function computeSidePoolCount(
  client: LogClient,
  chainId: number,
  token: string,
  primaryPoolId: string | null,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<number | null> {
  const pm = getChainConfig(chainId).uniswap.v4PoolManager.address as Hex;
  const tk = addressToTopic(token);
  const initTopic = POOL_EVENT_TOPIC0.v4Initialize as Hex;
  try {
    const [asC0, asC1] = await Promise.all([
      withRetry(
        () =>
          getLogsChunked(client, {
            address: pm,
            topics: [initTopic, null, tk], // currency0 == token
            fromBlock,
            toBlock,
            maxRange,
          }),
        { tries: 3, delayMs: 2000 },
      ),
      withRetry(
        () =>
          getLogsChunked(client, {
            address: pm,
            topics: [initTopic, null, null, tk], // currency1 == token
            fromBlock,
            toBlock,
            maxRange,
          }),
        { tries: 3, delayMs: 2000 },
      ),
    ]);
    const ids = new Set<string>();
    for (const l of [...asC0, ...asC1]) if (l.topics[1]) ids.add(l.topics[1].toLowerCase());
    if (primaryPoolId) ids.delete(primaryPoolId.toLowerCase());
    return ids.size;
  } catch {
    return null;
  }
}

/** Distinct non-infra spenders the creator / cluster approved on the token. */
export async function computeCreatorDrainerApprovals(
  client: LogClient,
  chainId: number,
  token: string,
  owners: string[],
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: number,
): Promise<number | null> {
  if (owners.length === 0) return null;
  const infra = infraAddresses(chainId);
  const ownerTopics = [...new Set(owners.map(lc))].map((a) => addressToTopic(a));
  try {
    const logs = await withRetry(
      () =>
        getLogsByTopicValues(client, {
          address: token as Hex,
          topic0: APPROVAL_TOPIC0 as Hex,
          valuePosition: 1, // owner ∈ cluster
          values: ownerTopics,
          fromBlock,
          toBlock,
          maxRange,
        }),
      { tries: 3, delayMs: 2000 },
    );
    const spenders = new Set<string>();
    for (const l of logs) {
      const spender = l.topics[2] ? topicToAddress(l.topics[2]) : null;
      if (!spender || infra.has(spender)) continue;
      // an approval to the token itself or the pool is not a drainer signal
      if (spender === token.toLowerCase()) continue;
      spenders.add(spender);
    }
    return spenders.size;
  } catch {
    return null;
  }
}
