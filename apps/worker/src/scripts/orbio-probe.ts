/**
 * `pnpm orbio:probe --yes` — call each Orbio wrapper once against the LIVE MCP
 * and record the real response as a fixture under `test/fixtures/orbio/`.
 *
 * This mutates live account state and MUST be run deliberately:
 *   1. orbio_get_balance     read-only
 *   2. orbio_get_key_status  read-only
 *   3. orbio_create_key      mints a new gateway key, RETIRES the current one,
 *                            secret shown once (saved to .env ORBIO_API_KEY)
 *   4. orbio_revoke_key      disables the key just minted (no balance change)
 *   5. orbio_delete_key      ONE-WAY: disables the legacy pre-gateway OpenRouter
 *                            key and returns its unspent balance to the account
 *
 * Secrets are redacted from the written fixtures; the create_key secret goes to
 * .env only. Requires TOKEN_ENCRYPTION_KEY + a prior `pnpm orbio:auth`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../env';
import {
  callOrbioTool,
  connectOrbio,
  validateOrbioBalance,
  validateOrbioCreateKey,
  validateOrbioDeleteKey,
  validateOrbioKeyStatus,
  validateOrbioRevokeKey,
  type OrbioToolName,
} from '../metabolism/orbio-client';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', '..', 'test', 'fixtures', 'orbio');
const REPO_ENV = join(HERE, '..', '..', '..', '..', '.env');

// sk-orbio-…, sk-or-v1-…, sk-ant-… — key bodies use [A-Za-z0-9_-], so match past
// underscores too (an earlier version stopped at `_` and leaked the secret tail).
const SECRET_RE = /sk-[a-z0-9]+-[A-Za-z0-9_-]{4,}/gi;

/** Mask any OpenRouter/Orbio/Anthropic-shaped secret. */
function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_RE, 'sk-REDACTED') as unknown as T;
  }
  if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v);
    return out as T;
  }
  return value;
}

function writeFixture(name: OrbioToolName, raw: unknown): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(redactSecrets(raw), null, 2) + '\n', 'utf8');
  console.log(`  wrote ${file}`);
}

function upsertEnv(key: string, val: string): void {
  let text = '';
  try {
    text = readFileSync(REPO_ENV, 'utf8');
  } catch {
    /* no .env — skip */
  }
  const line = `${key}="${val}"`;
  if (new RegExp(`^${key}=.*$`, 'm').test(text)) {
    text = text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`;
  }
  writeFileSync(REPO_ENV, text, 'utf8');
}

async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.error(
      'Refusing to run without --yes.\n\n' +
        'orbio:probe makes 5 LIVE calls, three of them mutating:\n' +
        '  orbio_create_key  retires the current gateway key\n' +
        '  orbio_revoke_key  disables the key it just minted\n' +
        '  orbio_delete_key  ONE-WAY — disables the legacy OpenRouter key\n\n' +
        'Re-run:  pnpm orbio:probe --yes',
    );
    process.exit(1);
  }

  const { client, close } = await connectOrbio();
  try {
    console.log('\n1/5 orbio_get_balance');
    const balanceRaw = await callOrbioTool(client, 'orbio_get_balance', {});
    writeFixture('orbio_get_balance', balanceRaw);
    const balanceBefore = validateOrbioBalance(balanceRaw);
    console.log(`     balance.usd = ${balanceBefore.balance.usd}`);

    console.log('\n2/5 orbio_get_key_status');
    const statusRaw = await callOrbioTool(client, 'orbio_get_key_status', {});
    writeFixture('orbio_get_key_status', statusRaw);
    const statusBefore = validateOrbioKeyStatus(statusRaw);
    console.log(`     hasKey=${statusBefore.hasKey} prefix=${statusBefore.prefix ?? '—'}`);

    console.log('\n3/5 orbio_create_key { label: "launch-auditor probe" }  (retires the current key)');
    const createRaw = await callOrbioTool(client, 'orbio_create_key', { label: 'launch-auditor probe' });
    const created = validateOrbioCreateKey(createRaw);
    // The secret only ever exists here — persist it, then hard-scrub key+prefix
    // (not just the regex pass) before anything is written to the fixture.
    upsertEnv('ORBIO_API_KEY', created.key);
    writeFixture('orbio_create_key', { ...(createRaw as object), key: 'sk-orbio-REDACTED', prefix: 'sk-orbio-REDACTED' });
    console.log(`     minted ${created.prefix ?? created.key.slice(0, 12)}… — full secret written to .env ORBIO_API_KEY`);

    console.log('\n4/5 orbio_revoke_key  (disables the key just minted)');
    const revokeRaw = await callOrbioTool(client, 'orbio_revoke_key', {});
    writeFixture('orbio_revoke_key', revokeRaw);
    validateOrbioRevokeKey(revokeRaw);

    console.log('\n5/5 orbio_delete_key  (ONE-WAY: disables the legacy OpenRouter key)');
    const deleteRaw = await callOrbioTool(client, 'orbio_delete_key', {});
    writeFixture('orbio_delete_key', deleteRaw);
    validateOrbioDeleteKey(deleteRaw);

    console.log('\n— post-probe state —');
    const balanceAfter = validateOrbioBalance(await callOrbioTool(client, 'orbio_get_balance', {}));
    const statusAfter = validateOrbioKeyStatus(await callOrbioTool(client, 'orbio_get_key_status', {}));
    console.log(`  balance.usd: ${balanceBefore.balance.usd} → ${balanceAfter.balance.usd}`);
    console.log(`  hasKey:      ${statusBefore.hasKey} → ${statusAfter.hasKey}`);
    console.log('\n✅ 5 fixtures written to test/fixtures/orbio/. Run `pnpm verify`.');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('\norbio:probe failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
