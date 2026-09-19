import { describe, expect, it } from 'vitest';
import { runDeepdiveAgent, type AgentRun, type InvokeFn } from '../src/deepdive/agent';
import type { DeepdiveClient } from '../src/deepdive/openrouter';
import type { DeepdiveContext } from '../src/deepdive/tools';
import type { TargetPacket } from '../src/deepdive/packet';

const CLIENT = { model: 'anthropic/claude-x', openrouter: {} } as unknown as DeepdiveClient;
const CODE = {
  address: '0xtok',
  block: '10',
  codeHash: '0xh',
  codeSize: 1,
  isContract: true,
  isProxy: false,
  implementation: null,
  admin: null,
  beacon: null,
};
const PACKET: TargetPacket = {
  chainId: 4663,
  rpcChainId: 4663,
  chainIdMatches: true,
  tokenAddress: '0xtok',
  quoteAddress: null,
  creatorAddress: '0xcreator',
  source: 'pons',
  reportBlock: { number: '10', hash: '0xbh', timestampUtc: '2026-09-10T00:00:00.000Z' },
  launch: { block: '1', txHash: '0xl', at: null },
  code: CODE,
  implementationCode: null,
  pools: [],
  builtAtUtc: '2026-09-10T00:00:00.000Z',
};

const VALID = {
  p_insider_exit_24h: 0.3,
  p_drawdown_80_7d: 0.8,
  p_sell_impaired_24h: 0.5,
  evidence: [{ claim: 'thin pool', tx_or_url: null }],
  confidence: 0.6,
};

function ctx(over: Partial<DeepdiveContext> = {}): DeepdiveContext {
  return {
    addressTokenActivity: async () => [],
    tokenTransfers: async () => [],
    clusterExpand: async () => ({ creator: '0x', members: [] }) as never,
    priceSeries: async () => ({ points: [], coverage: { gaps: [] } }) as never,
    holderSnapshot: async () => ({ holderCount: 1, clusterSupplyPct: 0, top10NoncreatorPct: 0, totalSupply: 1n }) as never,
    contractCode: async () => ({
      address: '0xtok',
      block: '10',
      codeHash: '0xh',
      codeSize: 1,
      isContract: true,
      isProxy: false,
      implementation: null,
      admin: null,
      beacon: null,
    }),
    scanhoodScan: async () => null,
    scanhoodQuote: async () => null,
    ...over,
  };
}

type LooseTool = { function: { name: string; execute: (p: Record<string, unknown>) => Promise<unknown> } };

/** A fake model run: optionally drives one tool call, ends `turns` turns, returns `text`. */
const fakeInvoke =
  (opts: { text: string; turns?: number; usage?: Record<string, unknown>; callTool?: string; toolArgs?: Record<string, unknown>; throwOnText?: boolean }): InvokeFn =>
  async (_client, req) => {
    if (opts.callTool) {
      const t = (req.tools as LooseTool[]).find((x) => x?.function?.name === opts.callTool);
      if (t) await t.function.execute(opts.toolArgs ?? {});
    }
    for (let i = 0; i < (opts.turns ?? 1); i += 1) req.onTurnEnd({ generationId: `gen-${i}` });
    const run: AgentRun = {
      getText: async () => {
        if (opts.throwOnText) throw new Error('provider 500');
        return opts.text;
      },
      getResponse: async () => ({ id: `gen-${(opts.turns ?? 1) - 1}` }),
      getUsage: async () => opts.usage ?? {},
    };
    return run;
  };

const base = { client: CLIENT, packet: PACKET, maxSteps: 6, maxCostUsd: 0.2 };

describe('runDeepdiveAgent', () => {
  it('validates + clamps the model output and accumulates evidence + generation ids', async () => {
    const r = await runDeepdiveAgent(
      { ...base, ctx: ctx() },
      {
        invoke: fakeInvoke({
          text: JSON.stringify({ ...VALID, p_drawdown_80_7d: 1.3 }),
          turns: 2,
          usage: { totalCost: 0.031 },
          callTool: 'contract_code',
          toolArgs: { address: '0x00000000000000000000000000000000dec0ded1' },
        }),
      },
    );
    expect(r.output.p_drawdown_80_7d).toBe(1);
    expect(r.warnings.some((w) => /clamped to 1/.test(w))).toBe(true);
    expect(r.evidence.map((e) => e.tool)).toEqual(['contract_code']);
    expect(r.generationIds).toEqual(['gen-0', 'gen-1']);
    expect(r.steps).toBe(2);
    expect(r.usageCostUsd).toBe(0.031);
    expect(r.stoppedBy).toBe('complete');
    expect(r.modelSlug).toBe('anthropic/claude-x');
  });

  it('records a limitation (not a finding) when a tool read fails', async () => {
    const r = await runDeepdiveAgent(
      {
        ...base,
        ctx: ctx({
          contractCode: async () => {
            throw new Error('archive: missing trie node');
          },
        }),
      },
      { invoke: fakeInvoke({ text: JSON.stringify(VALID), callTool: 'contract_code', toolArgs: { address: '0x00000000000000000000000000000000dec0ded1' } }) },
    );
    expect(r.evidence).toHaveLength(0);
    expect(r.limitations[0]).toMatchObject({ tool: 'contract_code', reason: 'archive: missing trie node' });
  });

  it('throws when the model output is not valid JSON / schema', async () => {
    await expect(
      runDeepdiveAgent({ ...base, ctx: ctx() }, { invoke: fakeInvoke({ text: 'not json' }) }),
    ).rejects.toThrow(/failed validation/);
    await expect(
      runDeepdiveAgent({ ...base, ctx: ctx() }, { invoke: fakeInvoke({ text: JSON.stringify({ confidence: 1 }) }) }),
    ).rejects.toThrow(/failed validation/);
  });

  it('returns a safe error result when the run itself fails', async () => {
    const r = await runDeepdiveAgent(
      { ...base, ctx: ctx() },
      { invoke: fakeInvoke({ text: '', throwOnText: true }) },
    );
    expect(r.stoppedBy).toBe('error');
    expect(r.output.p_insider_exit_24h).toBe(0);
    expect(r.warnings[0]).toMatch(/model run failed/);
  });

  it('reports stoppedBy max_steps when turns hit the cap', async () => {
    const r = await runDeepdiveAgent(
      { ...base, maxSteps: 2, ctx: ctx() },
      { invoke: fakeInvoke({ text: JSON.stringify(VALID), turns: 2 }) },
    );
    expect(r.stoppedBy).toBe('max_steps');
  });
});
