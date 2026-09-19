/**
 * The `llm_deepdive_v0` tool belt (spec §5, tool list rewritten in
 * `checkpoint-decisions-m4.md §D`). Nine read-only tools over the existing
 * M1–M4 providers, plus OpenRouter's `web_search` server tool.
 *
 * Each tool takes a validated zod input, calls one method of a per-target
 * {@link DeepdiveContext} (bound to a specific launch in M6b), and returns an
 * evidence-shaped {@link ToolOutput}. A context method that cannot complete a
 * read throws — the tool turns that into a `limitations` entry, never a finding.
 */
import { serverTool, tool } from '@openrouter/agent';
import { z } from 'zod';
import type { TokenTransfer } from '../history/provider';
import type { ClusterResult } from '../watcher/cluster';
import type { HolderStats } from '../watcher/holders';
import type { PricePoint, Series } from '../outcomes/series';
import type { ScanHoodMapped, ScanHoodQuote } from '../scanners/scanhood';
import type { ContractCode } from './contract-code';
import { limited, ok, rows, type ToolOutput } from './evidence';

/**
 * Per-target provider bundle. Bound to one launch (token, creator, pool,
 * liquidity source, block window) by `buildDeepdiveContext` in M6b; the tools
 * never see raw clients.
 */
export interface DeepdiveContext {
  addressTokenActivity(p: {
    address: string;
    token?: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<TokenTransfer[]>;
  tokenTransfers(p: { token: string; fromBlock: bigint; toBlock: bigint }): Promise<TokenTransfer[]>;
  clusterExpand(p: { creator: string }): Promise<ClusterResult>;
  priceSeries(p: { poolId: string; fromBlock: bigint; toBlock: bigint }): Promise<Series<PricePoint>>;
  holderSnapshot(p: { token: string; block: bigint }): Promise<HolderStats>;
  contractCode(p: { address: string; block?: bigint }): Promise<ContractCode>;
  scanhoodScan(p: { token: string }): Promise<ScanHoodMapped | null>;
  scanhoodQuote(p: { token: string; sizeUsdg: number }): Promise<ScanHoodQuote | null>;
}

const MAX_ROWS = 200;

const hexAddr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');
const blockNum = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);
const toBig = (v: number | string): bigint => BigInt(v);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const transferRow = (t: TokenTransfer) => ({
  token: t.token,
  from: t.from,
  to: t.to,
  value: t.value.toString(),
  block: t.block.toString(),
  txHash: t.txHash,
});

/**
 * Build the 8 client tools. `onResult` (M6b) receives every tool's
 * {@link ToolOutput} so the agent can accumulate the evidence / limitations the
 * model saw without re-deriving them.
 */
export function buildDeepdiveTools(ctx: DeepdiveContext, onResult?: (out: ToolOutput) => void) {
  const emit = (out: ToolOutput): ToolOutput => {
    onResult?.(out);
    return out;
  };
  const guard = async (
    name: string,
    query: Record<string, unknown>,
    produce: () => Promise<ToolOutput>,
  ): Promise<ToolOutput> => {
    try {
      return emit(await produce());
    } catch (e) {
      return emit(limited(name, query, errText(e)));
    }
  };

  const addressTokenActivity = tool({
    name: 'address_token_activity',
    description:
      'ERC-20 transfers touching an address in a block window (oldest first). Optional single-token filter. RPC-logs only — misses native-ETH funding.',
    inputSchema: z.object({
      address: hexAddr,
      token: hexAddr.optional(),
      fromBlock: blockNum,
      toBlock: blockNum,
    }),
    execute: (p): Promise<ToolOutput> =>
      guard('address_token_activity', { ...p }, async () => {
        const ts = await ctx.addressTokenActivity({
          address: p.address,
          token: p.token,
          fromBlock: toBig(p.fromBlock),
          toBlock: toBig(p.toBlock),
        });
        return ok({
          tool: 'address_token_activity',
          query: { ...p },
          source: 'rpc-logs',
          block: String(p.toBlock),
          value: { count: ts.length, transfers: ts.slice(0, MAX_ROWS).map(transferRow), truncated: ts.length > MAX_ROWS },
        });
      }),
  });

  const tokenTransfers = tool({
    name: 'token_transfers',
    description: 'All ERC-20 Transfer logs for one token contract in a block window (oldest first). Keep the window small.',
    inputSchema: z.object({ token: hexAddr, fromBlock: blockNum, toBlock: blockNum }),
    execute: (p): Promise<ToolOutput> =>
      guard('token_transfers', { ...p }, async () => {
        const ts = await ctx.tokenTransfers({
          token: p.token,
          fromBlock: toBig(p.fromBlock),
          toBlock: toBig(p.toBlock),
        });
        return ok({
          tool: 'token_transfers',
          query: { ...p },
          source: 'rpc-logs',
          block: String(p.toBlock),
          value: { count: ts.length, transfers: ts.slice(0, MAX_ROWS).map(transferRow), truncated: ts.length > MAX_ROWS },
        });
      }),
  });

  const clusterExpand = tool({
    name: 'cluster_expand',
    description:
      'Expand the creator cluster: funder / sibling / direct-transfer-recipient addresses with a per-rule confidence. Rule 4 (first-ever inbound) is disabled (no index).',
    inputSchema: z.object({ creator: hexAddr }),
    execute: (p): Promise<ToolOutput> =>
      guard('cluster_expand', { ...p }, async () => {
        const c = await ctx.clusterExpand({ creator: p.creator });
        return ok({
          tool: 'cluster_expand',
          query: { ...p },
          source: 'rpc-logs',
          block: null,
          value: {
            creator: p.creator.toLowerCase(),
            members: c.members.map((m) => ({ address: m.address, rule: m.rule, confidence: m.confidence, evidenceTx: m.evidenceTx })),
          },
        });
      }),
  });

  const priceSeries = tool({
    name: 'price_series',
    description: 'Trade prices from Swap logs for the primary pool over a block window (oldest first; token decimals NOT applied). Includes coverage gaps.',
    inputSchema: z.object({ poolId: z.string(), fromBlock: blockNum, toBlock: blockNum }),
    execute: (p): Promise<ToolOutput> =>
      guard('price_series', { ...p }, async () => {
        const s = await ctx.priceSeries({
          poolId: p.poolId,
          fromBlock: toBig(p.fromBlock),
          toBlock: toBig(p.toBlock),
        });
        return rows('price_series', [
          {
            tool: 'price_series',
            query: { ...p },
            source: 'rpc-logs',
            block: String(p.toBlock),
            value: {
              points: s.points.slice(0, MAX_ROWS).map((pt) => ({ block: pt.block.toString(), price: pt.price, txHash: pt.txHash })),
              count: s.points.length,
              coverage: s.coverage,
            },
          },
        ]);
      }),
  });

  const holderSnapshot = tool({
    name: 'holder_snapshot',
    description: 'Reconstructed holder stats at a block: holder count, cluster supply %, top-10 non-creator %. From Transfer logs (net balances).',
    inputSchema: z.object({ token: hexAddr, block: blockNum }),
    execute: (p): Promise<ToolOutput> =>
      guard('holder_snapshot', { ...p }, async () => {
        const h = await ctx.holderSnapshot({ token: p.token, block: toBig(p.block) });
        return ok({
          tool: 'holder_snapshot',
          query: { ...p },
          source: 'rpc-logs',
          block: String(p.block),
          value: {
            holderCount: h.holderCount,
            clusterSupplyPct: h.clusterSupplyPct,
            top10NoncreatorPct: h.top10NoncreatorPct,
            totalSupply: h.totalSupply === null ? null : h.totalSupply.toString(),
          },
        });
      }),
  });

  const contractCode = tool({
    name: 'contract_code',
    description: 'Runtime bytecode hash + size and EIP-1967 proxy resolution (implementation / admin / beacon) for an address, optionally pinned to a block.',
    inputSchema: z.object({ address: hexAddr, block: blockNum.optional() }),
    execute: (p): Promise<ToolOutput> =>
      guard('contract_code', { ...p }, async () => {
        const c = await ctx.contractCode({
          address: p.address,
          block: p.block === undefined ? undefined : toBig(p.block),
        });
        return ok({ tool: 'contract_code', query: { ...p }, source: 'rpc', block: c.block, value: c });
      }),
  });

  const scanhoodScan = tool({
    name: 'scanhood_scan',
    description: 'ScanHood token report: honeypot simulation (sellable), round-trip loss %, LP status, deployer history, verdict. Corroboration only.',
    inputSchema: z.object({ token: hexAddr }),
    execute: (p): Promise<ToolOutput> =>
      guard('scanhood_scan', { ...p }, async () => {
        const s = await ctx.scanhoodScan({ token: p.token });
        if (!s) return limited('scanhood_scan', { ...p }, 'ScanHood returned no data for this token');
        return ok({ tool: 'scanhood_scan', query: { ...p }, source: 'scanhood', block: null, value: s });
      }),
  });

  const scanhoodQuote = tool({
    name: 'scanhood_quote',
    description: 'ScanHood simulated sell of `sizeUsdg` worth of the token: amountIn / amountOut / venue, or an error. Corroboration for sell-impact only.',
    inputSchema: z.object({ token: hexAddr, sizeUsdg: z.number().positive() }),
    execute: (p): Promise<ToolOutput> =>
      guard('scanhood_quote', { ...p }, async () => {
        const q = await ctx.scanhoodQuote({ token: p.token, sizeUsdg: p.sizeUsdg });
        if (!q) return limited('scanhood_quote', { ...p }, 'ScanHood returned no quote');
        return ok({ tool: 'scanhood_quote', query: { ...p }, source: 'scanhood', block: null, value: q });
      }),
  });

  return [
    addressTokenActivity,
    tokenTransfers,
    clusterExpand,
    priceSeries,
    holderSnapshot,
    contractCode,
    scanhoodScan,
    scanhoodQuote,
  ] as const;
}

/**
 * OpenRouter server tools available to the deep-dive. `web_search` runs on the
 * gateway side; evidence rows may cite a URL but the agent never fetches one
 * itself (checkpoint §D).
 */
export const DEEPDIVE_SERVER_TOOLS = [serverTool({ type: 'web_search_2025_08_26' })] as const;

export const DEEPDIVE_TOOL_NAMES = [
  'address_token_activity',
  'token_transfers',
  'cluster_expand',
  'price_series',
  'holder_snapshot',
  'contract_code',
  'scanhood_scan',
  'scanhood_quote',
  'web_search',
] as const;
