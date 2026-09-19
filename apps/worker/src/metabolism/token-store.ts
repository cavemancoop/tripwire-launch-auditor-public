import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SpendBaseline } from './ids-reconcile';

/**
 * AES-256-GCM for the Orbio OAuth token at rest (`.env` `TOKEN_ENCRYPTION_KEY`,
 * 32 bytes base64). The token never touches the DB or logs in plaintext; only
 * this module holds it decrypted, briefly, to hand to the MCP client.
 *
 * Wire format (base64): [12-byte IV][16-byte auth tag][ciphertext].
 */
const IV_LEN = 12;
const TAG_LEN = 16;

export function loadEncryptionKey(base64Key: string | undefined): Buffer {
  if (!base64Key) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptToken(wire: string, key: Buffer): string {
  const buf = Buffer.from(wire, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** first 12 hex chars of sha256(token) — safe to log / store as `keyHashPrefix`. */
export async function keyHashPrefix(token: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/** Generate a fresh 32-byte key, base64 — for `.env` setup. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Persisted OAuth store
 *
 * The Orbio MCP OAuth flow (spec §8.1 "clone, `pnpm orbio:auth`, `pnpm start`")
 * produces three things the worker must keep between processes: the dynamically
 * registered client, the PKCE verifier (only across the redirect), and the
 * tokens. All three live in ONE JSON blob, encrypted as a unit with
 * `encryptToken` above and written to a gitignored file. Nothing here is ever
 * logged; callers get the decrypted blob in memory only.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface OrbioOAuthBlob {
  /** result of RFC 7591 dynamic client registration */
  clientInformation?: OAuthClientInformationFull;
  /** PKCE code_verifier — set only between authorize-redirect and code exchange */
  codeVerifier?: string;
  /** access + refresh tokens */
  tokens?: OAuthTokens;
  /**
   * The gateway key minted by `orbio_create_key` (secret shown once). Persisted
   * here — encrypted, same blob as the OAuth token — so the deep-dive (M6) can
   * use it and a worker restart does not orphan the key. Cleared on revoke.
   */
  gatewayKey?: string;
  /** `sk-orbio-…` prefix of `gatewayKey`, safe to log */
  gatewayKeyPrefix?: string;
  /** M5b-3: per-key IDS baseline — `(provider spent, local ledger Σ)` snapshotted
   *  when `gatewayKey` was minted. Cleared on revoke. */
  spendBaseline?: SpendBaseline;
  /** ISO timestamp of the last write, for the lifecycle log / diagnostics */
  updatedAt?: string;
}

const STORE_FILENAME = 'token-store.enc.json';

/** Walk up from `startDir` for the file that marks the monorepo root. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/**
 * Absolute path to the encrypted store. `ORBIO_TOKEN_STORE` wins; otherwise
 * `<repo-root>/.orbio/token-store.enc.json`.
 */
export function tokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ORBIO_TOKEN_STORE?.trim();
  if (override) return override;
  return join(findRepoRoot(process.cwd()), '.orbio', STORE_FILENAME);
}

/** Read + decrypt the store. Returns an empty blob when the file is absent. */
export function readOAuthBlob(path: string, key: Buffer): OrbioOAuthBlob {
  if (!existsSync(path)) return {};
  const wire = readFileSync(path, 'utf8').trim();
  if (!wire) return {};
  const blob = JSON.parse(decryptToken(wire, key)) as OrbioOAuthBlob;
  return blob ?? {};
}

/** Encrypt + write the store, creating the directory. Mode 0600 where supported. */
export function writeOAuthBlob(path: string, key: Buffer, blob: OrbioOAuthBlob): void {
  mkdirSync(dirname(path), { recursive: true });
  const wire = encryptToken(
    JSON.stringify({ ...blob, updatedAt: new Date().toISOString() }),
    key,
  );
  writeFileSync(path, wire + '\n', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Merge `patch` into the on-disk blob under a read-modify-write. Passing
 * `codeVerifier: null` / `tokens: null` deletes that field (used by
 * `invalidateCredentials`).
 */
export function updateOAuthBlob(
  path: string,
  key: Buffer,
  patch: Partial<Record<keyof OrbioOAuthBlob, unknown>>,
): OrbioOAuthBlob {
  const current = readOAuthBlob(path, key);
  const next: OrbioOAuthBlob = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete (next as Record<string, unknown>)[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  writeOAuthBlob(path, key, next);
  return next;
}
