import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assembleDeepdiveReport,
  assembleDeepdiveReportSigned,
  DEEPDIVE_OUTCOME_KEYS,
} from '../src/deepdive/report';
import type { TargetPacket } from '../src/deepdive/packet';
import type { DeepDiveResult } from '../src/deepdive/schema';

const AGENT = `0x${'11'.repeat(32)}` as const;
const TOKEN = '0x00000000000000000000000000000000dec0ded1';

const PACKET: TargetPacket = {
  chainId: 4663,
  rpcChainId: 4663,
  chainIdMatches: true,
  tokenAddress: TOKEN,
  quoteAddress: null,
  creatorAddress: '0xcreator',
  source: 'pons',
  reportBlock: { number: '2000', hash: `0x${'ab'.repeat(32)}`, timestampUtc: '2026-09-10T00:00:00.000Z' },
  launch: { block: '1000', txHash: '0xl', at: null },
  code: {
    address: TOKEN,
    block: '2000',
    codeHash: '0xhash',
    codeSize: 10,
    isContract: true,
    isProxy: false,
    implementation: null,
    admin: null,
    beacon: null,
  },
  implementationCode: null,
  pools: [],
  builtAtUtc: '2026-09-10T00:00:00.000Z',
};

const RESULT: DeepDiveResult = {
  output: {
    p_insider_exit_24h: 0.42,
    p_drawdown_80_7d: 0.71,
    p_sell_impaired_24h: 0.6,
    evidence: [{ claim: 'thin LP', tx_or_url: null }],
    confidence: 0.55,
  },
  evidence: [],
  limitations: [{ tool: 'price_series', query: {}, reason: 'archive gap' }],
  warnings: ['confidence 1.2 clamped to 1'],
  modelSlug: 'anthropic/claude-x-2026',
  targetPacket: PACKET,
  generationIds: ['g1'],
  usageCostUsd: 0.03,
  steps: 3,
  stoppedBy: 'complete',
};

const input = (over: Record<string, unknown> = {}) => ({
  chainId: 4663,
  tokenAddress: TOKEN,
  launchId: 'launch-1',
  trigger: 'qualified',
  packet: PACKET,
  result: RESULT,
  ...over,
});

describe('assembleDeepdiveReport', () => {
  it('maps the three deep-dive probabilities to outcome keys', () => {
    const d = assembleDeepdiveReport(input());
    expect(d.content.forecaster).toBe('llm_deepdive_v0');
    expect(d.content.forecasterVersion).toBe('anthropic/claude-x-2026');
    expect(d.content.probabilities).toEqual({
      [DEEPDIVE_OUTCOME_KEYS.p_insider_exit_24h]: 0.42,
      [DEEPDIVE_OUTCOME_KEYS.p_drawdown_80_7d]: 0.71,
      [DEEPDIVE_OUTCOME_KEYS.p_sell_impaired_24h]: 0.6,
    });
  });

  it('carries confidence + evidence and folds limitations/warnings into coverage', () => {
    const d = assembleDeepdiveReport(input());
    expect(d.content.confidence).toBe(0.55);
    expect(d.content.evidence).toEqual([{ claim: 'thin LP', tx_or_url: null }]);
    expect(d.content.coverage).toContain('price_series: archive gap');
    expect(d.content.coverage).toContain('confidence 1.2 clamped to 1');
  });

  it('pins the block from the packet and sets reportTime to the pin timestamp', () => {
    const d = assembleDeepdiveReport(input());
    expect(d.content.blockPin).toEqual({ number: 2000, hash: `0x${'ab'.repeat(32)}`, timestamp: '2026-09-10T00:00:00.000Z' });
    expect(d.content.reportTime).toBe('2026-09-10T00:00:00.000Z');
  });

  it('fails the §8.3 validator when unsigned', () => {
    const d = assembleDeepdiveReport(input());
    expect(d.validatorPassed).toBe(false);
    expect(d.validatorFailures).toContain('report is unsigned');
  });
});

describe('assembleDeepdiveReportSigned', () => {
  it('signs with the agent key and passes the validator', async () => {
    const d = await assembleDeepdiveReportSigned(input({ agentPrivateKey: AGENT }));
    expect(d.signer).toBe(privateKeyToAccount(AGENT).address);
    expect(d.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(d.validatorPassed).toBe(true);
    expect(d.validatorFailures).toEqual([]);
  });

  it('flags a chain-id mismatch in coverage', async () => {
    const badPacket = { ...PACKET, chainIdMatches: false, rpcChainId: 1 };
    const d = await assembleDeepdiveReportSigned(input({ agentPrivateKey: AGENT, packet: badPacket }));
    expect(d.content.coverage.some((c) => /chain id mismatch/.test(c))).toBe(true);
  });
});
