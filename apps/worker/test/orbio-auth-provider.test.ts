import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbioAuthProvider } from '../src/metabolism/orbio-client';
import { generateEncryptionKey, loadEncryptionKey, readOAuthBlob } from '../src/metabolism/token-store';

// 2026-09-12: a worker tick raced `pnpm orbio:auth` and the SDK's failed-refresh
// path wiped a freshly issued token within a minute. These pin the two provider
// behaviours that make the worker harmless to an in-progress sign-in.

let dir: string;
let storePath: string;
const key = loadEncryptionKey(generateEncryptionKey());
const TOKENS = { access_token: 'at-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'rt-1' } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbio-provider-'));
  storePath = join(dir, 'store.enc.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const provider = (over: { onAuthorize?: () => void; useRefreshToken?: boolean } = {}) =>
  new OrbioAuthProvider({ encryptionKey: key, storePath, callbackPort: 8976, ...over });

describe('OrbioAuthProvider.tokens() — never hand the SDK a refresh_token by default', () => {
  it('strips refresh_token so a 401 cannot trigger the SDK\'s destructive refresh', () => {
    const p = provider();
    p.saveTokens({ ...TOKENS });
    const t = p.tokens();
    expect(t?.access_token).toBe('at-1');
    expect(t).not.toHaveProperty('refresh_token');
    // …but the refresh_token is still persisted, for when Orbio's grant works
    expect(readOAuthBlob(storePath, key).tokens?.refresh_token).toBe('rt-1');
  });

  it('passes it through when explicitly enabled', () => {
    const p = provider({ useRefreshToken: true });
    p.saveTokens({ ...TOKENS });
    expect(p.tokens()?.refresh_token).toBe('rt-1');
  });

  it('returns undefined when nothing is stored', () => {
    expect(provider().tokens()).toBeUndefined();
  });
});

describe('OrbioAuthProvider.saveCodeVerifier() — the worker must not clobber the sign-in', () => {
  it('a non-interactive provider keeps the verifier in memory and leaves the disk alone', () => {
    const interactive = provider({ onAuthorize: () => {} });
    interactive.saveCodeVerifier('verifier-from-orbio-auth');

    const worker = provider(); // no onAuthorize
    worker.saveCodeVerifier('verifier-from-a-worker-tick');

    // the interactive sign-in's verifier is untouched on disk…
    expect(readOAuthBlob(storePath, key).codeVerifier).toBe('verifier-from-orbio-auth');
    expect(interactive.codeVerifier()).toBe('verifier-from-orbio-auth');
    // …and the worker can still read back its own for the SDK's bookkeeping
    expect(worker.codeVerifier()).toBe('verifier-from-a-worker-tick');
  });

  it('an interactive provider persists the verifier across the redirect', () => {
    const p = provider({ onAuthorize: () => {} });
    p.saveCodeVerifier('v');
    expect(readOAuthBlob(storePath, key).codeVerifier).toBe('v');
    // a fresh interactive instance (post-redirect) reads it back from disk
    expect(provider({ onAuthorize: () => {} }).codeVerifier()).toBe('v');
  });

  it('a non-interactive provider with no verifier throws NotAuthed, not undefined', () => {
    expect(() => provider().codeVerifier()).toThrow(/code verifier/);
  });
});

describe('OrbioAuthProvider.invalidateCredentials()', () => {
  it('scope "tokens" clears tokens but keeps the registered client', () => {
    const p = provider();
    p.saveClientInformation({ client_id: 'c1', redirect_uris: ['http://localhost:8976/callback'] });
    p.saveTokens({ ...TOKENS });
    p.invalidateCredentials('tokens');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()?.client_id).toBe('c1');
  });
});
