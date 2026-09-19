/**
 * The `llm_deepdive_v0` structured output (spec §5). Every field is typed and
 * range-checked; the only free text is `evidence[].claim`, which never feeds
 * back into another prompt.
 */
import { z } from 'zod';
import type { EvidenceRow, Limitation } from './evidence';
import type { TargetPacket } from './packet';

const prob = z.number();
const CLAIM_MAX = 600;
const REF_MAX = 400;
const EVIDENCE_MAX = 40;

export const DeepDiveOutputSchema = z.object({
  /** P(an insider-cluster wallet nets a sell ≥ its launch-window buys within 24h) */
  p_insider_exit_24h: prob,
  /** P(price down ≥ 80% from the first-hour high within 7d) */
  p_drawdown_80_7d: prob,
  /** P(a 1,000-USDG sell moves price > the §1 SELL_IMPAIRED threshold within 24h) */
  p_sell_impaired_24h: prob,
  evidence: z
    .array(
      z.object({
        claim: z.string().min(1),
        /** a tx hash or URL a human can check; null when the claim is a model inference */
        tx_or_url: z.string().nullable(),
      }),
    )
    .min(1),
  /** 0..1 self-rated confidence in the three probabilities */
  confidence: z.number(),
});

export type DeepDiveOutput = z.infer<typeof DeepDiveOutputSchema>;

/** JSON Schema handed to the model as `text.format` (strict / no extra keys). */
export const DEEPDIVE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'p_insider_exit_24h',
    'p_drawdown_80_7d',
    'p_sell_impaired_24h',
    'evidence',
    'confidence',
  ],
  properties: {
    p_insider_exit_24h: { type: 'number', minimum: 0, maximum: 1 },
    p_drawdown_80_7d: { type: 'number', minimum: 0, maximum: 1 },
    p_sell_impaired_24h: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: EVIDENCE_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'tx_or_url'],
        properties: {
          claim: { type: 'string', maxLength: CLAIM_MAX },
          tx_or_url: { type: ['string', 'null'], maxLength: REF_MAX },
        },
      },
    },
  },
} as const;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Defensive normalisation of a *structurally valid* model output: clamp
 * probabilities to [0,1], cap evidence count and text length. Returns the
 * cleaned output plus a list of what had to be adjusted (recorded, not hidden).
 */
export function clampDeepDiveOutput(raw: DeepDiveOutput): { output: DeepDiveOutput; warnings: string[] } {
  const warnings: string[] = [];
  const fix = (label: string, n: number): number => {
    const c = clamp01(n);
    if (c !== n) warnings.push(`${label} ${n} clamped to ${c}`);
    return c;
  };
  let evidence = raw.evidence.map((e) => ({
    claim: e.claim.length > CLAIM_MAX ? e.claim.slice(0, CLAIM_MAX) : e.claim,
    tx_or_url: e.tx_or_url && e.tx_or_url.length > REF_MAX ? e.tx_or_url.slice(0, REF_MAX) : e.tx_or_url,
  }));
  if (evidence.length > EVIDENCE_MAX) {
    warnings.push(`evidence truncated ${evidence.length} → ${EVIDENCE_MAX}`);
    evidence = evidence.slice(0, EVIDENCE_MAX);
  }
  return {
    output: {
      p_insider_exit_24h: fix('p_insider_exit_24h', raw.p_insider_exit_24h),
      p_drawdown_80_7d: fix('p_drawdown_80_7d', raw.p_drawdown_80_7d),
      p_sell_impaired_24h: fix('p_sell_impaired_24h', raw.p_sell_impaired_24h),
      evidence,
      confidence: fix('confidence', raw.confidence),
    },
    warnings,
  };
}

/** What `runDeepdiveAgent` returns. */
export interface DeepDiveResult {
  output: DeepDiveOutput;
  /** every tool evidence row the agent collected, in call order */
  evidence: EvidenceRow[];
  /** coverage limitations hit during the run (RPC errors, missing data) */
  limitations: Limitation[];
  /** normalisation adjustments + any run warnings */
  warnings: string[];
  modelSlug: string;
  targetPacket: TargetPacket;
  /** OpenRouter generation ids, one per turn — for `GET /generation?id=` costing.
   *  Empty through the Orbio gateway, which does not surface them. */
  generationIds: string[];
  /** provider-reported cost from the usage object, when the gateway includes one
   *  (OpenRouter does; the Orbio gateway does not). Not an estimate — see cost.ts. */
  usageCostUsd: number | null;
  /** M5c: token counts from the usage object, so cost can be *estimated* with an
   *  explicit basis when no provider cost is reported. Optional only so
   *  pre-M5c fixtures compile — `runDeepdiveAgent` always sets both. */
  promptTokens?: number | null;
  completionTokens?: number | null;
  steps: number;
  stoppedBy: 'complete' | 'max_steps' | 'max_cost' | 'error';
}
