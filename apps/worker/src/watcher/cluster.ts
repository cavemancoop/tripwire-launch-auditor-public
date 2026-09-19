import { getLogsChunked } from '@launch-auditor/chain';
import type { Hex, PublicClient } from 'viem';
import { TRANSFER_TOPIC0, addressToTopic, topicToAddress } from './erc20';

// Creator cluster v1 (spec §3.2). Deliberately narrow. Four membership rules,
// each carrying an evidence tx. Shared bridge / CEX funding is NOT association.

export type ClusterRule =
  | 'CREATOR' // rule 1
  | 'LAUNCH_BLOCK_BUY' // rule 2
  | 'DIRECT_TRANSFER' // rule 3
  | 'FIRST_INBOUND'; // rule 4

/** Per-rule membership confidence (v1, hand-set; tune against resolved data later). */
export const RULE_CONFIDENCE: Record<ClusterRule, number> = {
  CREATOR: 1.0,
  LAUNCH_BLOCK_BUY: 0.9, // Noxa: launch-block buys are creator-only; other pads: still strong
  DIRECT_TRANSFER: 0.7,
  FIRST_INBOUND: 0.85,
};

export interface ClusterMemberResult {
  address: string;
  rule: ClusterRule;
  evidenceTx: string | null;
  confidence: number;
}

export interface ClusterResult {
  members: ClusterMemberResult[];
  /** distinct member addresses */
  size: number;
  /** §3.2 "cluster confidence is published" — mean of member-row confidences (v1) */
  confidence: number;
  /** rules whose RPC lookup failed transiently — cluster may be incomplete */
  partial: ClusterRule[];
}

/**
 * Rule 4 needs each candidate wallet's first-ever inbound tx on chain. The only
 * clean source is an address-history index (Blockscout), which is 403 from the
 * server. This interface lets a real backend slot in later (self-hosted
 * Blockscout, an archive indexer); until then rule 4 contributes nothing.
 */
export interface FirstInboundLookup {
  firstFunder(address: string): Promise<string | null>;
}

export const UNAVAILABLE_FIRST_INBOUND: FirstInboundLookup = {
  async firstFunder() {
    return null;
  },
};

export interface BuildClusterParams {
  client: Pick<PublicClient, 'request'>;
  token: Hex;
  creator: string;
  /** address tokens leave on a buy: v4 PoolManager, else the v2/v3 pool contract */
  liquiditySource: string;
  launchBlock: bigint;
  /** blocks after launch to scan for rule-3 direct transfers (default: T+10m window) */
  windowBlocks: bigint;
  maxRange: number;
  firstInbound?: FirstInboundLookup;
}

function addMember(
  rows: ClusterMemberResult[],
  address: string,
  rule: ClusterRule,
  evidenceTx: string | null,
): void {
  const a = address.toLowerCase();
  if (rows.some((r) => r.address === a && r.rule === rule)) return;
  rows.push({ address: a, rule, evidenceTx, confidence: RULE_CONFIDENCE[rule] });
}

export async function buildCreatorCluster(p: BuildClusterParams): Promise<ClusterResult> {
  const creator = p.creator.toLowerCase();
  const liq = p.liquiditySource.toLowerCase();
  const rows: ClusterMemberResult[] = [];

  // rule 1 — the creator
  addMember(rows, creator, 'CREATOR', null);

  // rule 2 — bought in the launch block (token Transfer from the pool, that block only).
  // A transient RPC failure on one rule must not lose the others.
  const partial: ClusterRule[] = [];
  try {
    const launchBlockBuys = await getLogsChunked(p.client, {
      address: p.token,
      topics: [TRANSFER_TOPIC0 as Hex, addressToTopic(liq)],
      fromBlock: p.launchBlock,
      toBlock: p.launchBlock,
      maxRange: p.maxRange,
    });
    for (const log of launchBlockBuys) {
      const to = log.topics[2] ? topicToAddress(log.topics[2]) : null;
      if (!to || to === liq || to === creator) continue; // creator already in via rule 1
      addMember(rows, to, 'LAUNCH_BLOCK_BUY', log.transactionHash);
    }
  } catch {
    partial.push('LAUNCH_BLOCK_BUY');
  }

  // rule 3 — received tokens directly from the creator, within the window
  const recipients = new Set<string>();
  try {
    const fromCreator = await getLogsChunked(p.client, {
      address: p.token,
      topics: [TRANSFER_TOPIC0 as Hex, addressToTopic(creator)],
      fromBlock: p.launchBlock,
      toBlock: p.launchBlock + p.windowBlocks,
      maxRange: p.maxRange,
    });
    for (const log of fromCreator) {
      const to = log.topics[2] ? topicToAddress(log.topics[2]) : null;
      if (!to || to === creator || to === liq) continue; // creator -> pool is adding LP, not clustering
      recipients.add(to);
      addMember(rows, to, 'DIRECT_TRANSFER', log.transactionHash);
    }
  } catch {
    partial.push('DIRECT_TRANSFER');
  }

  // rule 4 — first-ever inbound on chain came from the creator.
  // Check the recipients surfaced by rule 3 (a wallet the creator funded into
  // existence). No-op until a FirstInboundLookup backend is wired.
  const lookup = p.firstInbound ?? UNAVAILABLE_FIRST_INBOUND;
  for (const addr of recipients) {
    if (rows.some((r) => r.address === addr && r.rule === 'FIRST_INBOUND')) continue;
    const funder = await lookup.firstFunder(addr);
    if (funder && funder.toLowerCase() === creator) {
      addMember(rows, addr, 'FIRST_INBOUND', null);
    }
  }

  const size = new Set(rows.map((r) => r.address)).size;
  const confidence = rows.length
    ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length
    : 0;
  return { members: rows, size, confidence, partial };
}

/** Distinct addresses in a cluster result, lowercased. */
export function clusterAddresses(result: ClusterResult): Set<string> {
  return new Set(result.members.map((m) => m.address));
}
