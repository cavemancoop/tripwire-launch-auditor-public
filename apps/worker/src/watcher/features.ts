import { getLogsChunked } from '@launch-auditor/chain';
import { erc20Abi, type Hex, type PublicClient } from 'viem';
import type { LogClient } from './detect';
import { TRANSFER_TOPIC0, ZERO_ADDRESS, addressToTopic, topicToAddress, transferValue } from './erc20';

// ── Index lane (spec §3.3 items 1, 2, 8) — computed immediately ─────────

export interface IndexFeatures {
  creatorDevbuyPct: number | null; // item 2: the insider's share bought in the launch tx
  /** address the dev buy landed on (may differ from tx.from — see Pons note) */
  devbuyRecipient: string | null;
  hasX: boolean | null; // item 8: presence only — needs launchpad metadata, deferred
  hasSite: boolean | null;
}

export type ReceiptClient = Pick<
  PublicClient,
  'getTransactionReceipt' | 'readContract'
>;

/**
 * `creator_devbuy_pct` (spec §3.3.2). Measures the largest single non-pool
 * recipient of the new token inside the launch transaction, over total supply —
 * NOT tokens received specifically by `tx.from`. Spec §8.2 (Pons note): on a
 * bonding-curve launch the tx is sent by a router/curve contract and the buy
 * lands on a *recipient* address, so a sender-based count reads 0. Recipient-
 * based is also correct for raw launches, where the creator is that recipient.
 *
 * `liquiditySource` (v4 PoolManager or the v2/v3 pool) is excluded; the zero
 * address (mint) is too. The caller compares `devbuyRecipient` to the creator.
 */
export async function computeIndexFeatures(
  client: ReceiptClient,
  token: Hex,
  launchTxHash: Hex,
  liquiditySource: string,
): Promise<IndexFeatures> {
  let creatorDevbuyPct: number | null = null;
  let devbuyRecipient: string | null = null;
  try {
    const receipt = await client.getTransactionReceipt({ hash: launchTxHash });
    const tokenLc = token.toLowerCase();
    const excluded = new Set([liquiditySource.toLowerCase(), ZERO_ADDRESS, tokenLc]);

    const receivedBy = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== tokenLc) continue;
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0 || log.topics.length < 3) continue;
      const to = topicToAddress(log.topics[2] as string);
      if (excluded.has(to)) continue;
      receivedBy.set(to, (receivedBy.get(to) ?? 0n) + transferValue(log.data));
    }

    let topAmount = 0n;
    for (const [addr, amt] of receivedBy) {
      if (amt > topAmount) {
        topAmount = amt;
        devbuyRecipient = addr;
      }
    }

    const totalSupply = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'totalSupply',
    })) as bigint;
    if (totalSupply > 0n) {
      creatorDevbuyPct = Number((topAmount * 100n * 10n ** 12n) / totalSupply) / 1e12;
    }
  } catch {
    // leave null; refined on the qualified lane / M2
  }
  return { creatorDevbuyPct, devbuyRecipient, hasX: null, hasSite: null };
}

// ── T+10m lane (spec §3.3 item 6) — via a delayed job ──────────────────
// Items 4, 5 (cluster) and 7 (liquidity USD / sell impact) land in M2.

export interface T10Features {
  uniqueBuyers10m: number | null;
  buysPerBuyer10m: number | null;
}

/**
 * A correctly-classified new token has hundreds of transfers in 10 min, not
 * tens of thousands. Blowing past this cap almost always means `tokenAddress`
 * is actually a quote asset — bail rather than page through it.
 */
export const MAX_T10_LOGS = 8000;

export interface T10Params {
  token: Hex;
  /** v2/v3 pool contract, or the v4 PoolManager — the address tokens leave on a buy. */
  liquiditySource: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  maxRange: number;
}

export async function computeT10Features(
  client: LogClient,
  p: T10Params,
): Promise<T10Features> {
  try {
    const logs = await getLogsChunked(client, {
      address: p.token,
      topics: [TRANSFER_TOPIC0 as Hex, addressToTopic(p.liquiditySource)],
      fromBlock: p.fromBlock,
      toBlock: p.toBlock,
      maxRange: p.maxRange,
    });
    if (logs.length > MAX_T10_LOGS) {
      // token is almost certainly a misclassified quote asset
      return { uniqueBuyers10m: null, buysPerBuyer10m: null };
    }
    // Transfers where from == liquiditySource == tokens flowing to a buyer.
    const buyers = new Map<string, number>();
    for (const log of logs) {
      const toTopic = log.topics[2];
      if (!toTopic) continue;
      const to = topicToAddress(toTopic);
      buyers.set(to, (buyers.get(to) ?? 0) + 1);
    }
    if (buyers.size === 0) return { uniqueBuyers10m: 0, buysPerBuyer10m: 0 };
    let totalBuys = 0;
    for (const n of buyers.values()) totalBuys += n;
    return {
      uniqueBuyers10m: buyers.size,
      buysPerBuyer10m: totalBuys / buyers.size,
    };
  } catch {
    return { uniqueBuyers10m: null, buysPerBuyer10m: null };
  }
}
