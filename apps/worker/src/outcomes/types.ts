import type { Coverage } from './coverage';

/** Outcome resolution verdict for one (label, horizon) cell. */
export interface Resolution {
  /** RESOLVED with a boolean, NA (does not apply), or UNRESOLVABLE (data gap) */
  status: 'RESOLVED' | 'NA' | 'UNRESOLVABLE';
  value: boolean | null;
  /** measurements / tx hashes backing the verdict */
  evidence: Record<string, unknown>;
  coverage: Coverage | null;
  /** short human reason, always set for NA / UNRESOLVABLE */
  reason?: string;
}

export const resolved = (
  value: boolean,
  evidence: Record<string, unknown>,
  coverage: Coverage | null,
): Resolution => ({ status: 'RESOLVED', value, evidence, coverage });

export const unresolvable = (
  reason: string,
  coverage: Coverage | null = null,
  evidence: Record<string, unknown> = {},
): Resolution => ({ status: 'UNRESOLVABLE', value: null, evidence, coverage, reason });

export const notApplicable = (reason: string): Resolution => ({
  status: 'NA',
  value: null,
  evidence: {},
  coverage: null,
  reason,
});
