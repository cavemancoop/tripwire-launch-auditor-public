import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { runDeepdive, type RunDeepdiveDeps } from '../src/deepdive/run';
import type { WorkerEnv } from '../src/env';
import type { DeepDiveResult } from '../src/deepdive/schema';
import type { TargetPacket, PacketClient } from '../src/deepdive/packet';
import type { DeepdiveContext } from '../src/deepdive/tools';

const AGENT = `0x${'22'.repeat(32)}` as const;
const TOKEN = '0x00000000000000000000000000000000dec0ded1';

const ENV = {
  openrouterModelDeepdive: 'anthropic/claude-x-2026',
  deepdiveCapPerRunUsd: 0.2,
  deepdiveDailyCapUsd: 5,
  deepdiveMaxSteps: 8,
  agentPrivateKey: AGENT,
  metabolismReserveUsd: 3,
  scanhoodApiBase: 'https://scanhood.xyz',
} as unknown as WorkerEnv;

const LAUNCH = {
  id: 'launch-1',
  chainId: 4663,
  tokenAddress: TOKEN,
  quoteAddress: null,
  creatorAddress: '0xcreator',
  launchBlock: 1000n,
  launchTxHash: '0xl',
  launchAt: null,
  source: 'pons',
  poolKind: 'v4',
  poolAddress: null,
  poolId: '0xpool',
  poolFee: 3000,
  poolTickSpacing: 60,
  poolHooks: null,
  poolFeeSuspect: false,
} as never;

const PACKET_CLIENT: PacketClient = {
  getChainId: async () => 4663,
  getBlock: async () => ({ number: 2000n, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_760_000_000n }),
  getCode: async () => '0x6001',
  getStorageAt: async () => `0x${'00'.repeat(32)}`,
};

const CTX = {} as DeepdiveContext;

const AGENT_RESULT = (packet: TargetPacket): DeepDiveResult => ({
  output: {
    p_insider_exit_24h: 0.3,
    p_drawdown_80_7d: 0.8,
    p_sell_impaired_24h: 0.5,
    evidence: [{ claim: 'x', tx_or_url: null }],
    confidence: 0.6,
  },
  evidence: [],
  limitations: [],
  warnings: [],
  modelSlug: 'anthropic/claude-x-2026',
  targetPacket: packet,
  generationIds: ['g1', 'g2'],
  usageCostUsd: 0.02,
  steps: 2,
  stoppedBy: 'complete',
});

function deps(over: Partial<RunDeepdiveDeps> = {}): RunDeepdiveDeps {
  return {
    env: ENV,
    packetClient: PACKET_CLIENT,
    buildContext: () => CTX,
    client: { model: ENV.openrouterModelDeepdive } as never,
    loadLaunch: async () => LAUNCH,
    existingDeepdiveReport: async () => null,
    reportIdByHash: async () => 'report-99',
    loadBudget: async () => ({ todaySpendUsd: 1, spendableUsd: 30 }),
    runAgent: async ({ packet }) => AGENT_RESULT(packet),
    persist: vi.fn(async () => ({ stored: 1, passed: 1, failed: 0 })),
    recordSpend: vi.fn(async () => ({ totalCostUsd: 0.017, rows: [], failed: [] })),
    keyHashPrefix: 'kp-1',
    ...over,
  };
}

describe('runDeepdive', () => {
  it('runs the full pipeline and returns a signed, validated report', async () => {
    const d = deps();
    const r = await runDeepdive({ launchId: 'launch-1', trigger: 'qualified' }, d);
    expect(r.ran).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.validatorPassed).toBe(true);
    expect(r.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.costUsd).toBe(0.017);
    expect(r.probabilities?.p_drawdown_80_7d).toBe(0.8);

    expect(d.persist).toHaveBeenCalledTimes(1);
    const draft = (d.persist as ReturnType<typeof vi.fn>).mock.calls[0]![0][0];
    expect(draft.content.forecaster).toBe('llm_deepdive_v0');
    expect(draft.signer).toBe(privateKeyToAccount(AGENT).address);

    expect(d.recordSpend).toHaveBeenCalledWith(
      expect.objectContaining({ keyHashPrefix: 'kp-1', reportId: 'report-99' }),
      expect.anything(),
    );
  });

  it('refuses when the model slug is missing / not pinned', async () => {
    const r = await runDeepdive(
      { launchId: 'launch-1', trigger: 'qualified' },
      deps({ env: { ...ENV, openrouterModelDeepdive: 'openrouter/auto' } as WorkerEnv }),
    );
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/identifiable|not set/);
  });

  it('refuses (no agent call) when the budget gate blocks', async () => {
    const runAgent = vi.fn();
    const r = await runDeepdive(
      { launchId: 'launch-1', trigger: 'qualified' },
      deps({ loadBudget: async () => ({ todaySpendUsd: 5, spendableUsd: 30 }), runAgent: runAgent as never }),
    );
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/^budget: daily cap/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  // 2026-09-12: a dead model slug (no provider) made every call fail, and the
  // pipeline still built + signed + persisted 168 all-zero "did not complete"
  // reports as if they were real forecasts, before any commit or spend check.
  it('a failed model run (stoppedBy: error) is never built, signed, or persisted', async () => {
    const failedResult = (packet: TargetPacket): DeepDiveResult => ({
      ...AGENT_RESULT(packet),
      output: { p_insider_exit_24h: 0, p_drawdown_80_7d: 0, p_sell_impaired_24h: 0, evidence: [{ claim: 'model run did not complete', tx_or_url: null }], confidence: 0 },
      warnings: ['model run failed: 404 model_not_available'],
      generationIds: [],
      usageCostUsd: null,
      stoppedBy: 'error',
    });
    const persist = vi.fn();
    const recordSpend = vi.fn();
    const r = await runDeepdive(
      { launchId: 'launch-1', trigger: 'qualified' },
      deps({ runAgent: async ({ packet }) => failedResult(packet), persist, recordSpend }),
    );
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/model run failed/);
    expect(r.reportHash).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('skips a launch already scored by llm_deepdive_v0', async () => {
    const r = await runDeepdive(
      { launchId: 'launch-1', trigger: 'qualified' },
      deps({ existingDeepdiveReport: async () => ({ id: 'r-old' }) }),
    );
    expect(r).toEqual({ ran: false, reason: 'already scored by llm_deepdive_v0' });
  });

  it('caps the agent maxCost at min(gate, per-run cap)', async () => {
    let seenMaxCost = -1;
    await runDeepdive(
      { launchId: 'launch-1', trigger: 'qualified' },
      deps({
        loadBudget: async () => ({ todaySpendUsd: 4.93, spendableUsd: 30 }), // remaining 0.07
        runAgent: async ({ packet, maxCostUsd }) => {
          seenMaxCost = maxCostUsd;
          return AGENT_RESULT(packet);
        },
      }),
    );
    expect(seenMaxCost).toBe(0.07);
  });
});
