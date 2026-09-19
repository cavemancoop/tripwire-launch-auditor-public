/**
 * The tamper-evident hash chain behind `lifecycle_log` (spec §8 — "the signed
 * lifecycle log as evidence"). Kept here, next to the `LifecycleLog` model, so
 * the worker that writes rows and the API that serves them agree on one exact
 * canonicalisation. RFC 8785 canonical JSON of the body, keccak256 of that; each
 * row's `bodyHash` folds in the previous row's `bodyHash` via `prevHash`.
 */
import canonicalize from 'canonicalize';
import { keccak256, stringToHex, type Hex } from 'viem';

export const GENESIS_HASH: Hex = `0x${'00'.repeat(32)}`;

/** The signed body of one lifecycle row. Field set is frozen — changing it breaks every prior signature. */
export interface LifecycleBody {
  at: string; // ISO
  prevState: string | null;
  newState: string;
  reason: string;
  isSnapshot: boolean;
  keyHashPrefix: string | null;
  balanceUsd: number | null;
  keyRemainingUsd: number | null;
  reserveUsd: number | null;
  ledgerSpendUsd: number | null;
  providerSpendUsd: number | null;
  idsMismatch: boolean;
  prevHash: Hex;
}

export function lifecycleBodyHash(body: LifecycleBody): Hex {
  const s = canonicalize(body as object);
  if (s === undefined) throw new Error('canonicalize returned undefined');
  return keccak256(stringToHex(s));
}

/** A stored row as the verifier needs to see it (a superset of {@link LifecycleBody}). */
export interface LifecycleChainRow extends Omit<LifecycleBody, 'prevHash'> {
  prevHash: string | null;
  bodyHash: string | null;
}

export interface LifecycleChainCheck {
  /** every row's bodyHash recomputes AND its prevHash equals the previous row's bodyHash */
  linked: boolean;
  /** no row altered and no missing parent — forks allowed (every body recomputes, every prevHash names a row in the window) */
  intact: boolean;
  /** rows whose parent is an intact earlier row rather than the previous one — concurrent writers, not tampering */
  forks: number[];
  /** the first row's prevHash is the genesis hash (i.e. this is the whole chain, not a window) */
  startsAtGenesis: boolean;
  length: number;
  /** index of the first row that doesn't hash or whose parent is missing, or null (forks aren't breaks) */
  brokenAt: number | null;
}

function bodyOf(r: LifecycleChainRow, prevHash: Hex): LifecycleBody {
  return {
    at: r.at,
    prevState: r.prevState,
    newState: r.newState,
    reason: r.reason,
    isSnapshot: r.isSnapshot,
    keyHashPrefix: r.keyHashPrefix,
    balanceUsd: r.balanceUsd,
    keyRemainingUsd: r.keyRemainingUsd,
    reserveUsd: r.reserveUsd,
    ledgerSpendUsd: r.ledgerSpendUsd,
    providerSpendUsd: r.providerSpendUsd,
    idsMismatch: r.idsMismatch,
    prevHash,
  };
}

/** Verify a run of rows in ascending order. Works on a window (does not require the genesis row). */
export function verifyLifecycleRows(rows: LifecycleChainRow[]): LifecycleChainCheck {
  let linked = true;
  let brokenAt: number | null = null;
  const forks: number[] = [];
  const seenBodies = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    const prevHash = (r.prevHash ?? GENESIS_HASH) as Hex;
    const bodyOk = lifecycleBodyHash(bodyOf(r, prevHash)) === r.bodyHash;
    const linkOk = i === 0 ? true : r.prevHash === rows[i - 1]!.bodyHash;
    if (!linkOk) linked = false;
    if (!bodyOk) {
      linked = false;
      if (brokenAt === null) brokenAt = i;
    } else if (!linkOk) {
      // links to an intact earlier row, not the one before it: two signed rows
      // share a parent (two writers at once, e.g. deploy overlap). No row was
      // altered — but a parent that doesn't exist at all is a real break.
      if (r.prevHash && seenBodies.has(r.prevHash)) forks.push(i);
      else if (brokenAt === null) brokenAt = i;
    }
    if (r.bodyHash) seenBodies.add(r.bodyHash);
  }
  return {
    linked,
    intact: brokenAt === null,
    forks,
    startsAtGenesis: rows.length === 0 || (rows[0]!.prevHash ?? GENESIS_HASH) === GENESIS_HASH,
    length: rows.length,
    brokenAt,
  };
}
