import { describe, expect, it } from 'vitest';
import { clampDeepDiveOutput, DeepDiveOutputSchema, type DeepDiveOutput } from '../src/deepdive/schema';

const valid: DeepDiveOutput = {
  p_insider_exit_24h: 0.4,
  p_drawdown_80_7d: 0.7,
  p_sell_impaired_24h: 0.6,
  evidence: [{ claim: 'creator sold 30% in block 12', tx_or_url: '0xdead' }],
  confidence: 0.5,
};

describe('DeepDiveOutputSchema', () => {
  it('accepts a well-formed output', () => {
    expect(DeepDiveOutputSchema.parse(valid)).toEqual(valid);
  });
  it('rejects a missing probability', () => {
    const { p_drawdown_80_7d: _drop, ...rest } = valid;
    expect(DeepDiveOutputSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects a non-number probability and empty evidence', () => {
    expect(DeepDiveOutputSchema.safeParse({ ...valid, p_insider_exit_24h: 'high' }).success).toBe(false);
    expect(DeepDiveOutputSchema.safeParse({ ...valid, evidence: [] }).success).toBe(false);
  });
  it('allows a null tx_or_url (model inference)', () => {
    expect(
      DeepDiveOutputSchema.safeParse({ ...valid, evidence: [{ claim: 'inferred', tx_or_url: null }] }).success,
    ).toBe(true);
  });
});

describe('clampDeepDiveOutput', () => {
  it('clamps out-of-range probabilities and records warnings', () => {
    const { output, warnings } = clampDeepDiveOutput({
      ...valid,
      p_drawdown_80_7d: 1.5,
      p_sell_impaired_24h: -0.2,
      confidence: Number.NaN,
    });
    expect(output.p_drawdown_80_7d).toBe(1);
    expect(output.p_sell_impaired_24h).toBe(0);
    expect(output.confidence).toBe(0);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/clamped to 1/);
  });

  it('passes a clean output through with no warnings', () => {
    const { output, warnings } = clampDeepDiveOutput(valid);
    expect(output).toEqual(valid);
    expect(warnings).toEqual([]);
  });

  it('truncates an overlong claim', () => {
    const long = 'x'.repeat(900);
    const { output, warnings } = clampDeepDiveOutput({ ...valid, evidence: [{ claim: long, tx_or_url: null }] });
    expect(output.evidence[0]!.claim).toHaveLength(600);
    expect(warnings).toEqual([]); // truncation of a single field is silent; only clamps/count warn
  });

  it('caps the evidence array at 40 with a warning', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ claim: `c${i}`, tx_or_url: null }));
    const { output, warnings } = clampDeepDiveOutput({ ...valid, evidence: many });
    expect(output.evidence).toHaveLength(40);
    expect(warnings.some((w) => /evidence truncated 50/.test(w))).toBe(true);
  });
});
