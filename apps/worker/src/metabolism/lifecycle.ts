import { GENESIS_HASH, lifecycleBodyHash } from '@launch-auditor/db';
import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isManualReason, type LifecycleState } from './state';

export { GENESIS_HASH } from '@launch-auditor/db';

/**
 * The signed lifecycle log (spec §8 — "the signed lifecycle log as evidence").
 * Each entry is canonical-JSON hashed and signed by the instance's agent key,
 * and its `bodyHash` folds in the previous entry's `bodyHash`, so the whole log
 * is a tamper-evident chain without a schema change.
 */
export interface LifecycleEntryInput {
  prevState: LifecycleState | null;
  newState: LifecycleState;
  reason: string;
  isSnapshot?: boolean;
  keyHashPrefix?: string;
  balanceUsd?: number;
  keyRemainingUsd?: number;
  reserveUsd?: number;
  ledgerSpendUsd?: number;
  providerSpendUsd?: number;
  idsMismatch?: boolean;
  at?: string; // ISO; defaults to now
}

export interface LifecycleEntry extends LifecycleEntryInput {
  at: string;
  prevHash: Hex;
  bodyHash: Hex;
}

export function buildLifecycleEntry(
  input: LifecycleEntryInput,
  prevHash: Hex = GENESIS_HASH,
): LifecycleEntry {
  const body = {
    at: input.at ?? new Date().toISOString(),
    prevState: input.prevState,
    newState: input.newState,
    reason: input.reason,
    isSnapshot: input.isSnapshot ?? false,
    keyHashPrefix: input.keyHashPrefix ?? null,
    balanceUsd: input.balanceUsd ?? null,
    keyRemainingUsd: input.keyRemainingUsd ?? null,
    reserveUsd: input.reserveUsd ?? null,
    ledgerSpendUsd: input.ledgerSpendUsd ?? null,
    providerSpendUsd: input.providerSpendUsd ?? null,
    idsMismatch: input.idsMismatch ?? false,
    prevHash,
  };
  const bodyHash = lifecycleBodyHash(body);
  return { ...input, at: body.at, prevHash, bodyHash };
}

export function signLifecycleEntry(bodyHash: Hex, agentPrivateKey: Hex): Promise<Hex> {
  return privateKeyToAccount(agentPrivateKey).signMessage({ message: { raw: bodyHash } });
}

/** Verify a chain of entries links correctly (bodyHash_i feeds prevHash_{i+1}). */
export function verifyLifecycleChain(entries: LifecycleEntry[]): boolean {
  let prev: Hex = GENESIS_HASH;
  for (const e of entries) {
    if (e.prevHash !== prev) return false;
    const recomputed = buildLifecycleEntry(e, e.prevHash).bodyHash;
    if (recomputed !== e.bodyHash) return false;
    prev = e.bodyHash;
  }
  return true;
}

/** Days since the last `manual:` reason (spec §8 headline metric). Null = never
 *  a manual action recorded (report as "since instance start" upstream). */
export function daysSinceLastManualAction(
  entries: Array<{ reason: string; at: string }>,
  now: Date = new Date(),
): number | null {
  let last: number | null = null;
  for (const e of entries) {
    if (isManualReason(e.reason)) {
      const t = Date.parse(e.at);
      if (!Number.isNaN(t) && (last === null || t > last)) last = t;
    }
  }
  return last === null ? null : Math.max(0, (now.getTime() - last) / 86_400_000);
}
