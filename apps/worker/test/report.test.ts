import { describe, expect, it } from 'vitest';
import {
  agentAddress,
  canonicalJson,
  probabilitiesToColumns,
  recoverReportSigner,
  reportHash,
  signReportCommitment,
} from '../src/report/crypto';
import type { ReportDraft } from '../src/report/types';
import { validateReport } from '../src/report/validate';

// hardhat account #0 — a public test key
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN = '0x1111111111111111111111111111111111111111';
const HASH64 = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

describe('canonical JSON + hash', () => {
  it('is key-order independent', () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('reportHash is a 32-byte hex and stable', () => {
    const h = reportHash(canonicalJson({ x: 1 }));
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reportHash(canonicalJson({ x: 1 }))).toBe(h);
  });

  it('probabilitiesToColumns maps the outcome cells', () => {
    const c = probabilitiesToColumns({
      'INSIDER_EXIT@24h': 0.3,
      'DRAWDOWN_80@7d': 0.6,
      'TRADING_ALIVE@24h': 0.8,
    });
    expect(c.pInsiderExit24h).toBe(0.3);
    expect(c.pDrawdown80_7d).toBe(0.6);
    expect(c.pTradingAlive24h).toBe(0.8);
    expect(c.pSellImpaired1h).toBeNull();
  });
});

describe('EIP-712 report commitment', () => {
  it('signs and recovers to the agent address', async () => {
    expect(agentAddress(TEST_KEY).toLowerCase()).toBe(TEST_ADDR.toLowerCase());
    const m = {
      reportHash: HASH64 as `0x${string}`,
      chainId: 4663,
      token: TOKEN as `0x${string}`,
      reportTime: 1_788_000_000,
      forecaster: 'det_v0',
    };
    const { signature, signer } = await signReportCommitment(TEST_KEY, m);
    expect(signer.toLowerCase()).toBe(TEST_ADDR.toLowerCase());
    expect((await recoverReportSigner(m, signature)).toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });
});

function goodDraft(over: Partial<ReportDraft['content']> = {}): ReportDraft {
  const content: ReportDraft['content'] = {
    version: 'report/v0',
    chainId: 4663,
    tokenAddress: TOKEN,
    launchId: 'l1',
    reportTime: '2026-09-05T00:00:00.000Z',
    trigger: 'launch',
    blockPin: { number: 54_000_000, hash: HASH64, timestamp: '2026-09-05T00:00:00.000Z' },
    forecaster: 'det_v0',
    forecasterVersion: 'det_v0',
    outcomeRuleVersion: 'v1',
    probabilities: { 'INSIDER_EXIT@24h': 0.2, 'DRAWDOWN_80@24h': 0.4 },
    coverage: [],
    ...over,
  };
  const cj = canonicalJson(content);
  return {
    content,
    canonicalJson: cj,
    reportHash: reportHash(cj),
    signature: '0xsig' as `0x${string}`,
    signer: TEST_ADDR as `0x${string}`,
    validatorPassed: false,
    validatorFailures: [],
  };
}

const opts = { expectedChainId: 4663, expectedToken: TOKEN, agentAddress: TEST_ADDR };

describe('validateReport (§8.3)', () => {
  it('passes a well-formed, correctly-signed draft', () => {
    expect(validateReport(goodDraft(), opts).ok).toBe(true);
  });

  it('fails on chain mismatch', () => {
    const r = validateReport(goodDraft({ chainId: 1 }), opts);
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/chainId/);
  });

  it('fails on token mismatch', () => {
    const r = validateReport({ ...goodDraft(), content: { ...goodDraft().content, tokenAddress: '0x2222222222222222222222222222222222222222' } }, opts);
    expect(r.failures.join()).toMatch(/tokenAddress/);
  });

  it('fails on a fake block pin hash', () => {
    expect(validateReport(goodDraft({ blockPin: { number: 1, hash: '0xdead', timestamp: '2026-09-05T00:00:00Z' } }), opts).failures.join()).toMatch(/hash/);
  });

  it('fails when unsigned', () => {
    const d = goodDraft();
    d.signature = null;
    d.signer = null;
    expect(validateReport(d, opts).failures.join()).toMatch(/unsigned/);
  });

  it('fails when the signer is not the agent identity', () => {
    const d = goodDraft();
    d.signer = '0x0000000000000000000000000000000000000009' as `0x${string}`;
    expect(validateReport(d, opts).failures.join()).toMatch(/signer/);
  });

  it('fails a near-floor clean call made on mostly-unknown features', () => {
    const d = goodDraft({
      probabilities: { 'INSIDER_EXIT@24h': 0.01 },
      coverage: Array.from({ length: 18 }, (_, i) => `f${i}`),
    });
    expect(validateReport(d, opts).failures.join()).toMatch(/unknown/);
  });

  it('fails when reportHash does not match the canonical json', () => {
    const d = goodDraft();
    d.reportHash = HASH64;
    expect(validateReport(d, opts).failures.join()).toMatch(/keccak256/);
  });
});
