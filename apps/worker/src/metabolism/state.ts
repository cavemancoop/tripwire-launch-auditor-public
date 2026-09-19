/**
 * Metabolism state machine (spec §8, unchanged from v0.1 §7):
 *   NO_KEY → ACTIVE → DRAINING → ROTATING → ACTIVE
 *   any → REVOKING → NO_KEY            (IDS mismatch: local ledger vs provider)
 *   DRAINING/ROTATING/NO_KEY → STARVED (no credits to claim or rotate into)
 *   STARVED → ROTATING/ACTIVE          (credits returned)
 *
 * Pure: `nextState(current, event)` returns the new state + a reason string, or
 * null when the event does not apply in the current state.
 */
export type LifecycleState =
  | 'NO_KEY'
  | 'ACTIVE'
  | 'DRAINING'
  | 'ROTATING'
  | 'REVOKING'
  | 'STARVED';

export type LifecycleEvent =
  | 'KEY_CLAIMED' // a fresh OpenRouter key was claimed from Orbio
  | 'STATUS_OK' // periodic status poll: healthy, above reserve
  | 'LOW_BALANCE' // key remaining is low but still usable
  | 'HYGIENE_DUE' // key age >= hygieneRotateDays — rotate on schedule
  | 'DRAINED' // key remaining <= reserve
  | 'ROTATED' // new key claimed and the old one revoked
  | 'IDS_MISMATCH' // retired by M5c: a ledger/provider gap is an estimator error, not a compromise (kept for old rows)
  | 'PHANTOM_SPEND' // M5c: provider spend rose while the agent made no calls — the one compromise signal
  | 'REVOKED' // the key has been revoked at the provider
  | 'NO_CREDITS' // no accrued credits to claim / rotate into
  | 'CREDITS_RETURNED'; // credits accrued again after STARVED

export interface Transition {
  state: LifecycleState;
  reason: string;
}

const R = (state: LifecycleState, reason: string): Transition => ({ state, reason });

export function nextState(
  current: LifecycleState,
  event: LifecycleEvent,
): Transition | null {
  // A compromise signal always wins, from any state that holds a key.
  // PHANTOM_SPEND is the live one; IDS_MISMATCH is retained so historical rows
  // still replay through the machine.
  if (event === 'PHANTOM_SPEND') {
    return current === 'NO_KEY' ? null : R('REVOKING', 'phantom spend: provider charged with zero local requests');
  }
  if (event === 'IDS_MISMATCH') {
    return current === 'NO_KEY' ? null : R('REVOKING', 'ids: local ledger vs provider status mismatch');
  }
  if (event === 'REVOKED') {
    return current === 'REVOKING' ? R('NO_KEY', 'key revoked at provider') : null;
  }

  switch (current) {
    case 'NO_KEY':
      if (event === 'KEY_CLAIMED') return R('ACTIVE', 'claimed a fresh key');
      if (event === 'NO_CREDITS') return R('STARVED', 'no credits to claim a key');
      return null;

    case 'ACTIVE':
      if (event === 'LOW_BALANCE') return R('DRAINING', 'key remaining is low');
      if (event === 'DRAINED') return R('ROTATING', 'key drained below reserve');
      if (event === 'HYGIENE_DUE') return R('ROTATING', 'scheduled key rotation (hygiene)');
      // M5b-2 adaptation: balance below the hard reserve → STARVED directly. A
      // fresh key would spend the same empty balance, so there is nothing to
      // rotate into (2026-09-09 decision).
      if (event === 'NO_CREDITS') return R('STARVED', 'balance below the hard reserve — nothing to serve');
      if (event === 'STATUS_OK') return R('ACTIVE', 'status ok');
      return null;

    case 'DRAINING':
      if (event === 'DRAINED') return R('ROTATING', 'key drained below reserve');
      if (event === 'HYGIENE_DUE') return R('ROTATING', 'scheduled key rotation (hygiene)');
      if (event === 'NO_CREDITS') return R('STARVED', 'drained and no credits to rotate into');
      if (event === 'STATUS_OK') return R('ACTIVE', 'balance recovered above the low mark');
      return null;

    case 'ROTATING':
      if (event === 'ROTATED' || event === 'KEY_CLAIMED') return R('ACTIVE', 'rotated to a fresh key');
      if (event === 'NO_CREDITS') return R('STARVED', 'nothing to rotate into');
      return null;

    case 'STARVED':
      if (event === 'CREDITS_RETURNED') return R('ROTATING', 'credits accrued — rotating back in');
      if (event === 'KEY_CLAIMED') return R('ACTIVE', 'claimed a key after starvation');
      return null;

    case 'REVOKING':
      return null; // only REVOKED (handled above) leaves REVOKING

    default:
      return null;
  }
}

/** A reason string prefixed `manual:` marks a human credential action (spec §8
 *  "days since the last manual credential action"). */
export const manualReason = (what: string): string => `manual: ${what}`;
export const isManualReason = (reason: string): boolean => reason.startsWith('manual:');
