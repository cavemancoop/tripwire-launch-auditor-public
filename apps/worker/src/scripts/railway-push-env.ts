/**
 * `pnpm railway:push-env` — push the secrets a deployed worker needs from this
 * machine into a Railway service, without any of them touching the screen,
 * the clipboard, or shell history.
 *
 * Why it exists: a container has its own empty filesystem. `pnpm orbio:auth`
 * writes the gateway key to a local encrypted store (`.orbio/…`, gitignored)
 * that is never deployed, and `.env` is gitignored too. So a freshly deployed
 * worker has no gateway key (every deep-dive throws at the key resolver and is
 * counted as a silent skip) and no Telegram credentials (the free feed and the
 * ops alerts log "disabled" and do nothing).
 *
 * Measured 2026-09-14: a gateway key keeps billing inference normally with an
 * OAuth session that expired two days earlier — the session bounds *key
 * management* (create / revoke / read balance via the MCP), not spending. So
 * pushing the key once is enough for the deployed worker to run deep-dives
 * continuously. There is no callback port to expose and no volume to mount.
 *
 * Usage:
 *   pnpm railway:push-env                # push everything available, to `worker`
 *   pnpm railway:push-env --dry-run      # show what would be pushed, change nothing
 *   pnpm railway:push-env --service api  # a different service
 *   pnpm railway:push-env --only ORBIO_API_KEY
 *   pnpm railway:push-env --with-session # also push the Orbio MCP session (see below)
 *
 * --with-session: right after `pnpm orbio:auth`, also push ORBIO_SESSION_SEED —
 * the client registration + access token, re-encrypted with TOKEN_ENCRYPTION_KEY
 * and stripped of the gateway key and the refresh token (`session-seed.ts`) — and
 * METABOLISM_KEY_MANAGEMENT=observe, so the deployed lifecycle loop reads balance
 * and key status for ~1h but never mints or revokes. The worker writes the seed
 * to disk at boot only when no store exists. It is a separate flag because this
 * is a stronger secret than the key: see DECISIONS.md (2026-09-15).
 */
import { spawnSync } from 'node:child_process';
import { resolveGatewayKey } from '../deepdive/openrouter';
import { loadEnv } from '../env';
import { connectOrbio } from '../metabolism/orbio-client';
import { buildSessionSeed, SESSION_SEED_ENV } from '../metabolism/session-seed';
import { loadEncryptionKey, readOAuthBlob, tokenStorePath } from '../metabolism/token-store';

// The store is decrypted with TOKEN_ENCRYPTION_KEY, which lives in .env —
// resolveGatewayKey reads process.env, so the file has to be loaded first.
loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const service = arg('service') ?? 'worker';
const dryRun = process.argv.includes('--dry-run');
const only = arg('only');
const withSession = process.argv.includes('--with-session');

/** Shown instead of the value — enough to confirm, never enough to leak. */
function fingerprint(v: string): string {
  if (v.startsWith('@') || v.length <= 12) return v; // a channel handle / mode flag is not a secret
  if (v.startsWith('v1.')) return `session seed for key ${v.split('.')[1]} (${v.length} chars)`;
  return `${v.slice(0, 8)}…${v.slice(-4)} (${v.length} chars)`;
}

const candidates: Array<{ name: string; value: string; source: string }> = [
  { name: 'ORBIO_API_KEY', value: resolveGatewayKey(), source: 'encrypted token store' },
  { name: 'TELEGRAM_BOT_TOKEN', value: process.env.TELEGRAM_BOT_TOKEN ?? '', source: '.env' },
  { name: 'TELEGRAM_CHANNEL_ID', value: process.env.TELEGRAM_CHANNEL_ID ?? '', source: '.env' },
  { name: 'TELEGRAM_ALERTS_CHANNEL_ID', value: process.env.TELEGRAM_ALERTS_CHANNEL_ID ?? '', source: '.env' },
];

if (withSession) {
  // A dead session is worth nothing on Railway — prove it works here first
  // (listTools only: no key is created, read or revoked).
  try {
    const conn = await connectOrbio();
    await conn.client.listTools();
    await conn.close();
  } catch (e) {
    console.error(`--with-session: the local Orbio session does not work (${e instanceof Error ? e.message : e}).
Run \`pnpm orbio:auth\` and push again straight away — the access token lasts ~1h.`);
    process.exit(1);
  }
  const key = loadEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY);
  candidates.push(
    { name: SESSION_SEED_ENV, value: buildSessionSeed(readOAuthBlob(tokenStorePath(), key), key), source: 'encrypted token store (session only)' },
    { name: 'METABOLISM_KEY_MANAGEMENT', value: 'observe', source: '--with-session' },
  );
}

const selected = candidates.filter((c) => c.value && (!only || c.name === only));
const missing = candidates.filter((c) => !c.value && (!only || c.name === only));

if (selected.length === 0) {
  console.error('Nothing to push — none of the expected values are set locally.');
  for (const m of missing) console.error(`  ${m.name}: not found in ${m.source}`);
  process.exit(1);
}

console.log(`target service: ${service}\n`);
for (const c of selected) console.log(`  ${c.name.padEnd(28)} ${fingerprint(c.value)}   <- ${c.source}`);
for (const m of missing) console.log(`  ${m.name.padEnd(28)} (not set locally — skipping)`);

if (dryRun) {
  console.log('\n--dry-run: nothing was changed.');
  process.exit(0);
}

const args = ['variables', '--service', service];
for (const c of selected) args.push('--set', `${c.name}=${c.value}`);

const res = spawnSync('railway', args, {
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: process.platform === 'win32',
});

if (res.status !== 0) {
  console.error(
    `\nrailway exited ${res.status}. Is the CLI installed and linked?\n  railway login && railway link`,
  );
  process.exit(res.status ?? 1);
}

console.log(
  `\nPushed ${selected.length} variable(s). Railway redeploys the service automatically.\n` +
    `Watch it take effect:  railway logs --service ${service}` +
    (withSession
      ? `

The pushed session expires with its access token (~1h) and cannot be refreshed from Railway.
` +
        `Look for "[metabolism] session seed: wrote…" and "keys observe" in the worker log.
` +
        `Removing ${SESSION_SEED_ENV} from the service stops future boots seeding it; it does not revoke the token.`
      : ''),
);
