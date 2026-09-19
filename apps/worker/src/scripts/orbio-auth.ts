/**
 * `pnpm orbio:auth` — one-time interactive OAuth for the Orbio MCP (spec §8.1).
 *
 * Spins a localhost listener, opens the Orbio sign-in page in a browser, waits
 * for the redirect, exchanges the code, and leaves an encrypted token on disk
 * (`token-store.ts`). After this, `pnpm start` / `pnpm orbio:probe` connect with
 * no prompt. Re-run any time to re-authorize; it overwrites the stored token.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadEnv } from '../env';
import {
  connectOrbio,
  orbioAuthProviderFromEnv,
  orbioMcpUrl,
} from '../metabolism/orbio-client';
import { generateEncryptionKey } from '../metabolism/token-store';

loadEnv(); // side effect: load repo-root .env into process.env

const CALLBACK_PATH = '/callback';
const CLIENT_INFO = { name: 'launch-auditor', version: '0.0.0' } as const;

function openInBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // NOT `cmd /c start "" <url>`: Node leaves a URL unquoted (no spaces), so
      // cmd treats every `&` in the query string as a command separator — the
      // browser received `...?response_type=code` and Orbio replied "missing
      // client_id" (2026-09-12). rundll32 takes the URL as one argument with no
      // shell parsing.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* fall back to the printed URL */
  }
}

async function main(): Promise<void> {
  if (!process.env.TOKEN_ENCRYPTION_KEY?.trim()) {
    console.error(
      '\nTOKEN_ENCRYPTION_KEY is not set. Add this line to your .env and re-run:\n\n' +
        `  TOKEN_ENCRYPTION_KEY="${generateEncryptionKey()}"\n\n` +
        '(32 random bytes, base64 — it encrypts the persisted Orbio token at rest.)\n',
    );
    process.exit(1);
  }

  const url = orbioMcpUrl();
  const port = Number(process.env.ORBIO_OAUTH_CALLBACK_PORT ?? 8976);

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (u.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem">` +
          (code
            ? 'Orbio authorization complete. You can close this tab and return to the terminal.'
            : `Orbio authorization failed: ${error ?? 'no code returned'}.`) +
          '</body>',
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(`OAuth redirect carried no code (error=${error ?? 'none'})`));
    });
    server.on('error', reject);
    server.listen(port, () => {
      console.log(`Listening for the OAuth redirect on http://localhost:${port}${CALLBACK_PATH}`);
    });
  });

  const provider = orbioAuthProviderFromEnv(process.env, {
    onAuthorize: (authUrl) => {
      console.log('\nOpening the Orbio sign-in page in your browser:\n');
      console.log(`  ${authUrl.toString()}\n`);
      console.log('If it does not open, paste that URL into a browser signed in with the wallet holding $ORBIO.\n');
      openInBrowser(authUrl.toString());
    },
  });

  // First connect: no token yet → provider.redirectToAuthorization fires, then
  // the SDK throws UnauthorizedError. That is the expected path here.
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport);
    console.log('\nAlready authorized — the stored token still works. Nothing to do.');
    await client.close();
    return;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }

  const code = await codePromise;
  console.log('\nGot the authorization code. Exchanging it for a token…');
  await transport.finishAuth(code);
  await transport.close().catch(() => {});

  // Verify: a fresh non-interactive connect must now succeed.
  const conn = await connectOrbio({ url, env: process.env });
  const tools = await conn.client.listTools();
  await conn.close();

  console.log(
    `\n✅ Orbio MCP authorized. Token stored (encrypted). ${tools.tools.length} tools visible:\n` +
      tools.tools.map((t) => `   - ${t.name}`).join('\n') +
      '\n\nNext: `pnpm orbio:probe --yes` to capture live fixtures, or `pnpm start`.',
  );
}

main().catch((err) => {
  console.error('\norbio:auth failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
