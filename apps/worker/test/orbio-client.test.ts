import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  callOrbioTool,
  extractToolPayload,
  OrbioAuthProvider,
  orbioCreateKey,
  orbioDeleteKey,
  orbioGetBalance,
  orbioGetKeyStatus,
  orbioRevokeKey,
  ORBIO_TOOLS,
  validateOrbioBalance,
  validateOrbioCreateKey,
  validateOrbioDeleteKey,
  validateOrbioKeyStatus,
  validateOrbioRevokeKey,
} from '../src/metabolism/orbio-client';
import {
  generateEncryptionKey,
  loadEncryptionKey,
  readOAuthBlob,
  updateOAuthBlob,
} from '../src/metabolism/token-store';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/orbio/', import.meta.url));
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));

/** Minimal MCP client stub: returns the given payload for callTool(). */
function stubClient(
  payloadFor: (name: string) => unknown,
  mode: 'structured' | 'text' = 'structured',
): Client {
  return {
    async callTool({ name }: { name: string }) {
      const payload = payloadFor(name);
      return mode === 'structured'
        ? { content: [], structuredContent: payload }
        : { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  } as unknown as Client;
}

describe('extractToolPayload', () => {
  it('prefers structuredContent', () => {
    expect(extractToolPayload({ content: [], structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });
  it('parses a single JSON text block', () => {
    expect(extractToolPayload({ content: [{ type: 'text', text: '{"b":2}' }] })).toEqual({ b: 2 });
  });
  it('returns raw text when it is not JSON', () => {
    expect(extractToolPayload({ content: [{ type: 'text', text: 'hello' }] })).toBe('hello');
  });
  it('throws on isError, surfacing the text', () => {
    expect(() =>
      extractToolPayload({ isError: true, content: [{ type: 'text', text: 'no key' }] }),
    ).toThrow(/no key/);
  });
});

describe('callOrbioTool', () => {
  it('unwraps the payload from the MCP envelope', async () => {
    const client = stubClient(() => ({ ok: true }), 'text');
    await expect(callOrbioTool(client, 'orbio_get_balance', {})).resolves.toEqual({ ok: true });
  });
});

describe('zod schemas match the recorded live fixtures', () => {
  const cases: Array<[string, (p: unknown) => unknown]> = [
    ['orbio_get_balance', validateOrbioBalance],
    ['orbio_create_key', validateOrbioCreateKey],
    ['orbio_get_key_status', validateOrbioKeyStatus],
    ['orbio_revoke_key', validateOrbioRevokeKey],
    ['orbio_delete_key', validateOrbioDeleteKey],
  ];
  for (const [name, validate] of cases) {
    it(`${name}.json validates`, () => {
      expect(existsSync(join(FIXTURE_DIR, `${name}.json`))).toBe(true);
      expect(() => validate(loadFixture(name))).not.toThrow();
    });
  }

  it('covers all five Orbio tools', () => {
    expect([...ORBIO_TOOLS].sort()).toEqual(cases.map(([n]) => n).sort());
  });
});

describe('typed wrappers against the fixtures', () => {
  it('orbioGetBalance returns a numeric balance.usd', async () => {
    const b = await orbioGetBalance(stubClient(() => loadFixture('orbio_get_balance')));
    expect(typeof b.balance.usd).toBe('number');
  });

  it('orbioGetKeyStatus returns a boolean hasKey', async () => {
    const s = await orbioGetKeyStatus(stubClient(() => loadFixture('orbio_get_key_status')));
    expect(typeof s.hasKey).toBe('boolean');
  });

  it('orbioCreateKey returns a non-empty key and enforces the 60-char label cap', async () => {
    const client = stubClient(() => loadFixture('orbio_create_key'));
    const k = await orbioCreateKey(client, { label: 'ok' });
    expect(k.key.length).toBeGreaterThan(0);
    await expect(orbioCreateKey(client, { label: 'x'.repeat(61) })).rejects.toThrow(/60/);
  });

  it('orbioRevokeKey and orbioDeleteKey validate their fixtures', async () => {
    await expect(
      orbioRevokeKey(stubClient(() => loadFixture('orbio_revoke_key'))),
    ).resolves.toBeTypeOf('object');
    await expect(
      orbioDeleteKey(stubClient(() => loadFixture('orbio_delete_key'))),
    ).resolves.toBeTypeOf('object');
  });
});

describe('OrbioAuthProvider persistence (token-store round-trip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbio-store-'));
  const storePath = join(dir, 'store.enc.json');
  const key = loadEncryptionKey(generateEncryptionKey());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const provider = new OrbioAuthProvider({ encryptionKey: key, storePath, callbackPort: 8976 });

  it('starts empty', () => {
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
  });

  it('persists client info, verifier and tokens encrypted', () => {
    provider.saveClientInformation({ client_id: 'abc', redirect_uris: [provider.redirectUrl] });
    provider.saveCodeVerifier('pkce-verifier-123');
    provider.saveTokens({ access_token: 'sk-orbio-secret-xyz', token_type: 'Bearer' });

    expect(provider.clientInformation()?.client_id).toBe('abc');
    expect(provider.codeVerifier()).toBe('pkce-verifier-123');
    expect(provider.tokens()?.access_token).toBe('sk-orbio-secret-xyz');

    // ciphertext on disk must not leak the secret
    expect(readFileSync(storePath, 'utf8')).not.toContain('sk-orbio-secret-xyz');
  });

  it('invalidateCredentials("tokens") drops only the tokens', () => {
    provider.invalidateCredentials('tokens');
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe('abc');
  });

  it('updateOAuthBlob merge + delete semantics', () => {
    updateOAuthBlob(storePath, key, { codeVerifier: null });
    expect(readOAuthBlob(storePath, key).codeVerifier).toBeUndefined();
    expect(readOAuthBlob(storePath, key).clientInformation?.client_id).toBe('abc');
  });
});
