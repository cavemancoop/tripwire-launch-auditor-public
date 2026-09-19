import { describe, expect, it } from 'vitest';
import {
  buildDeepdiveTools,
  DEEPDIVE_SERVER_TOOLS,
  DEEPDIVE_TOOL_NAMES,
  type DeepdiveContext,
} from '../src/deepdive/tools';
import type { ToolOutput } from '../src/deepdive/evidence';

const TOKEN = '0x00000000000000000000000000000000dec0ded1';
const CREATOR = '0x00000000000000000000000000000000c0ffee01';

/** loose view of a built tool — sidesteps the union-of-signatures on `.execute` */
interface AnyTool {
  function: {
    name: string;
    inputSchema: { safeParse(v: unknown): { success: boolean } };
    execute(p: Record<string, unknown>): Promise<ToolOutput>;
  };
}

const transfer = (n: number) => ({
  token: TOKEN,
  from: CREATOR,
  to: `0x${String(n).padStart(40, '0')}`,
  value: 1000n,
  block: BigInt(100 + n),
  logIndex: n,
  txHash: `0xtx${n}`,
});

function fakeCtx(over: Partial<DeepdiveContext> = {}): DeepdiveContext {
  return {
    addressTokenActivity: async () => [transfer(1), transfer(2)],
    tokenTransfers: async () => [transfer(1)],
    clusterExpand: async () =>
      ({
        creator: CREATOR,
        members: [{ address: '0xaaa', rule: 'rule-2-funder', evidenceTx: '0xt', confidence: 0.7 }],
      }) as never,
    priceSeries: async () =>
      ({ points: [{ block: 5n, price: 1.5, txHash: '0xp' }], coverage: { gaps: [] } }) as never,
    holderSnapshot: async () =>
      ({ holderCount: 12, clusterSupplyPct: 0.3, top10NoncreatorPct: 0.2, totalSupply: 1_000_000n }) as never,
    contractCode: async () => ({
      address: TOKEN,
      block: null,
      codeHash: '0xhash',
      codeSize: 42,
      isContract: true,
      isProxy: false,
      implementation: null,
      admin: null,
      beacon: null,
    }),
    scanhoodScan: async () => ({ verdict: 'PASS', sellable: true }) as never,
    scanhoodQuote: async () => ({ side: 'sell', amountIn: '100', amountOut: '95' }) as never,
    ...over,
  };
}

const tools = (over?: Partial<DeepdiveContext>): AnyTool[] =>
  buildDeepdiveTools(fakeCtx(over)) as unknown as AnyTool[];
const byName = (name: string, over?: Partial<DeepdiveContext>): AnyTool => {
  const t = tools(over).find((x) => x.function.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe('deep-dive tool belt', () => {
  it('exposes 8 client tools in order + a web_search server tool', () => {
    expect(tools().map((t) => t.function.name)).toEqual([
      'address_token_activity',
      'token_transfers',
      'cluster_expand',
      'price_series',
      'holder_snapshot',
      'contract_code',
      'scanhood_scan',
      'scanhood_quote',
    ]);
    expect(DEEPDIVE_TOOL_NAMES).toHaveLength(9);
    expect(DEEPDIVE_SERVER_TOOLS).toHaveLength(1);
  });

  it('address_token_activity returns one evidence row with the query echoed', async () => {
    const out = await byName('address_token_activity').function.execute({
      address: CREATOR,
      fromBlock: 100,
      toBlock: 200,
    });
    expect(out.ok).toBe(true);
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]).toMatchObject({
      tool: 'address_token_activity',
      source: 'rpc-logs',
      block: '200',
      query: { address: CREATOR, fromBlock: 100, toBlock: 200 },
    });
    expect((out.evidence[0]!.value as { count: number }).count).toBe(2);
  });

  it('serializes bigint fields to strings', async () => {
    const out = await byName('holder_snapshot').function.execute({ token: TOKEN, block: 500 });
    expect((out.evidence[0]!.value as { totalSupply: string }).totalSupply).toBe('1000000');
  });

  it('a failing context read becomes a limitation, not a finding', async () => {
    const out = await byName('contract_code', {
      contractCode: async () => {
        throw new Error('archive node: missing trie node');
      },
    }).function.execute({ address: TOKEN });
    expect(out.ok).toBe(false);
    expect(out.evidence).toHaveLength(0);
    expect(out.limitations[0]).toMatchObject({
      tool: 'contract_code',
      reason: 'archive node: missing trie node',
    });
  });

  it('scanhood_scan reports a limitation when the provider has no data', async () => {
    const out = await byName('scanhood_scan', { scanhoodScan: async () => null }).function.execute({
      token: TOKEN,
    });
    expect(out.ok).toBe(false);
    expect(out.limitations[0]!.reason).toMatch(/no data/);
  });

  it('input schema rejects a malformed address', () => {
    const schema = byName('contract_code').function.inputSchema;
    expect(schema.safeParse({ address: 'nope' }).success).toBe(false);
    expect(schema.safeParse({ address: TOKEN }).success).toBe(true);
  });
});
