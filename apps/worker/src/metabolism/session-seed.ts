import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  decryptToken,
  encryptToken,
  loadEncryptionKey,
  tokenStorePath,
  writeOAuthBlob,
  type OrbioOAuthBlob,
} from './token-store';

/**
 * Seeding an Orbio MCP session into a container (`pnpm railway:push-env
 * --with-session`).
 *
 * A deployed worker has an empty filesystem, so it never has a token store and
 * can never read the balance — the lifecycle loop errors every tick and
 * property 2 (budget follows accrual) has nothing to derive from. The fix is to
 * ship the store as an env var and write it to disk at boot.
 *
 * Two things make the naive version dangerous, and this module removes both
 * from the seed before it ever leaves the laptop:
 *
 * - **the gateway key.** A container's disk is ephemeral. If the seed carried a
 *   key, every restart would restore the key *as of the push* — and the store
 *   outranks `ORBIO_API_KEY` in `resolveGatewayKey`, so a later key-only push
 *   would be silently shadowed by a retired key. The key travels only as
 *   `ORBIO_API_KEY`.
 * - **the refresh token.** Orbio's refresh grant is one-shot (2026-09-12). A
 *   copy on Railway would either race the laptop's copy or, if used, kill it.
 *   Without it the pushed session is bounded to one access-token lifetime
 *   (~1h) and cannot be extended by anyone holding the Railway env.
 *
 * What remains is the dynamically registered client and the access token —
 * enough to read balance and key status, and (without observe mode, below) to
 * mint or revoke for up to an hour.
 */

export const SESSION_SEED_ENV = 'ORBIO_SESSION_SEED';
const SEED_VERSION = 'v1';

/** 8 hex chars of sha256(key) — lets a worker say *which* key a seed wants, never the key. */
export function encryptionKeyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** The part of a store that is safe to seed: client registration + access token, nothing else. */
export function sessionOnly(blob: OrbioOAuthBlob): OrbioOAuthBlob {
  if (!blob.tokens?.access_token) {
    throw new Error('the local token store holds no access token — run `pnpm orbio:auth` first');
  }
  if (!blob.clientInformation) {
    throw new Error('the local token store holds no client registration — run `pnpm orbio:auth` first');
  }
  const { refresh_token: _refresh, ...tokens } = blob.tokens;
  return { clientInformation: blob.clientInformation, tokens };
}

/** `v1.<key fingerprint>.<AES-GCM wire>` — the value of {@link SESSION_SEED_ENV}. */
export function buildSessionSeed(blob: OrbioOAuthBlob, key: Buffer): string {
  const wire = encryptToken(JSON.stringify(sessionOnly(blob)), key);
  return `${SEED_VERSION}.${encryptionKeyFingerprint(key)}.${wire}`;
}

export interface SeedResult {
  seeded: boolean;
  reason: string;
}

/**
 * Boot hook: write {@link SESSION_SEED_ENV} to the store path **only when no
 * store file exists**, so it can never clobber a live local store. Never
 * throws — a bad seed must not stop the watcher or the commit loop.
 */
export function seedTokenStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SeedResult {
  const raw = env[SESSION_SEED_ENV]?.trim();
  if (!raw) return { seeded: false, reason: `${SESSION_SEED_ENV} not set` };

  const path = tokenStorePath(env);
  if (existsSync(path)) {
    return { seeded: false, reason: `a token store already exists at ${path} — seed ignored, never clobbered` };
  }

  let key: Buffer;
  try {
    key = loadEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  } catch (e) {
    return { seeded: false, reason: `cannot seed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== SEED_VERSION) {
    return { seeded: false, reason: `cannot seed: ${SESSION_SEED_ENV} is not a ${SEED_VERSION} seed` };
  }
  const [, wantFp, wire = ''] = parts;
  const haveFp = encryptionKeyFingerprint(key);
  if (wantFp !== haveFp) {
    return {
      seeded: false,
      reason: `cannot seed: encrypted for TOKEN_ENCRYPTION_KEY ${wantFp}, this worker has ${haveFp}`,
    };
  }

  let blob: OrbioOAuthBlob;
  try {
    // re-strip on the way in: a hand-built seed must not smuggle a key or refresh token
    blob = sessionOnly(JSON.parse(decryptToken(wire, key)) as OrbioOAuthBlob);
  } catch (e) {
    return { seeded: false, reason: `cannot seed: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    writeOAuthBlob(path, key, blob);
  } catch (e) {
    return { seeded: false, reason: `cannot seed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { seeded: true, reason: `wrote a session-only token store to ${path} (no gateway key, no refresh token)` };
}

export type KeyManagementMode = 'managed' | 'observe';

/**
 * `managed`: the lifecycle runner mints, rotates and revokes (local default).
 * `observe`: it reads balance and key status and logs what it *would* do, but
 * never calls `orbio_create_key` / `orbio_revoke_key`. Defaults to `observe`
 * whenever a session was seeded — a minted key would live only on an ephemeral
 * disk and retire the key the operator's laptop holds.
 */
export function keyManagementMode(env: NodeJS.ProcessEnv = process.env): KeyManagementMode {
  const explicit = env.METABOLISM_KEY_MANAGEMENT?.trim().toLowerCase();
  if (explicit === 'managed' || explicit === 'observe') return explicit;
  return env[SESSION_SEED_ENV]?.trim() ? 'observe' : 'managed';
}
