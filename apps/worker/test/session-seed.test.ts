import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSessionSeed,
  keyManagementMode,
  seedTokenStoreFromEnv,
  sessionOnly,
  SESSION_SEED_ENV,
} from '../src/metabolism/session-seed';
import {
  encryptToken,
  generateEncryptionKey,
  loadEncryptionKey,
  readOAuthBlob,
  type OrbioOAuthBlob,
} from '../src/metabolism/token-store';

const B64 = generateEncryptionKey();
const key = loadEncryptionKey(B64);
const FULL: OrbioOAuthBlob = {
  clientInformation: { client_id: 'c-1', redirect_uris: ['http://localhost:8976/callback'] },
  tokens: { access_token: 'at-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'rt-1' },
  codeVerifier: 'cv',
  gatewayKey: 'sk-orbio-abcdef0123456789',
  gatewayKeyPrefix: 'sk-orbio-abcdef',
  spendBaseline: { keyPrefix: 'sk-orbio-abcdef', providerSpentUsd: 1, ledgerUsd: 1, at: '2026-09-15T00:00:00Z' },
};

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbio-seed-'));
  storePath = join(dir, 'store.enc.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TOKEN_ENCRYPTION_KEY: B64,
  ORBIO_TOKEN_STORE: storePath,
  [SESSION_SEED_ENV]: buildSessionSeed(FULL, key),
  ...over,
});

describe('session seed — what leaves the laptop', () => {
  it('keeps only the client registration and the access token', () => {
    const s = sessionOnly(FULL);
    expect(Object.keys(s).sort()).toEqual(['clientInformation', 'tokens']);
    expect(s.tokens).not.toHaveProperty('refresh_token');
    expect(s.tokens?.access_token).toBe('at-1');
  });

  it('refuses a store with no session', () => {
    expect(() => sessionOnly({ gatewayKey: 'sk-orbio-x' })).toThrow(/orbio:auth/);
  });

  it('what lands on the container has no gateway key, refresh token, verifier or baseline', () => {
    seedTokenStoreFromEnv(env());
    const onDisk = readOAuthBlob(storePath, key);
    expect(onDisk.gatewayKey).toBeUndefined();
    expect(onDisk.spendBaseline).toBeUndefined();
    expect(onDisk.codeVerifier).toBeUndefined();
    expect(onDisk.tokens?.refresh_token).toBeUndefined();
    expect(onDisk.tokens?.access_token).toBe('at-1');
  });
});

describe('seedTokenStoreFromEnv — boot hook', () => {
  it('writes the store when none exists', () => {
    expect(seedTokenStoreFromEnv(env())).toMatchObject({ seeded: true });
  });

  it('never clobbers an existing store', () => {
    writeFileSync(storePath, 'live local store\n');
    const r = seedTokenStoreFromEnv(env());
    expect(r.seeded).toBe(false);
    expect(r.reason).toMatch(/never clobbered/);
  });

  it('is a no-op without the env var', () => {
    expect(seedTokenStoreFromEnv(env({ [SESSION_SEED_ENV]: '' })).seeded).toBe(false);
  });

  it('names a TOKEN_ENCRYPTION_KEY mismatch instead of throwing', () => {
    const r = seedTokenStoreFromEnv(env({ TOKEN_ENCRYPTION_KEY: generateEncryptionKey() }));
    expect(r.seeded).toBe(false);
    expect(r.reason).toMatch(/encrypted for TOKEN_ENCRYPTION_KEY [0-9a-f]{8}, this worker has [0-9a-f]{8}/);
  });

  it('rejects a malformed seed', () => {
    expect(seedTokenStoreFromEnv(env({ [SESSION_SEED_ENV]: 'garbage' })).reason).toMatch(/not a v1 seed/);
  });

  it('strips a hand-built seed that smuggles a key and refresh token', () => {
    const fp = buildSessionSeed(FULL, key).split('.')[1];
    const smuggled = `v1.${fp}.${encryptToken(JSON.stringify(FULL), key)}`;
    expect(seedTokenStoreFromEnv(env({ [SESSION_SEED_ENV]: smuggled })).seeded).toBe(true);
    const onDisk = readOAuthBlob(storePath, key);
    expect(onDisk.gatewayKey).toBeUndefined();
    expect(onDisk.tokens?.refresh_token).toBeUndefined();
  });
});

describe('keyManagementMode', () => {
  it('defaults to managed locally and observe when a seed is present', () => {
    expect(keyManagementMode({})).toBe('managed');
    expect(keyManagementMode({ [SESSION_SEED_ENV]: 'v1.x.y' })).toBe('observe');
  });

  it('an explicit value wins either way', () => {
    expect(keyManagementMode({ [SESSION_SEED_ENV]: 'v1.x.y', METABOLISM_KEY_MANAGEMENT: 'managed' })).toBe('managed');
    expect(keyManagementMode({ METABOLISM_KEY_MANAGEMENT: 'OBSERVE' })).toBe('observe');
  });
});
