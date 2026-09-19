/**
 * Orbio MCP client (spec §8 "Metabolism").
 *
 * A Streamable-HTTP MCP client for `ORBIO_MCP_URL` with an OAuth 2.1 provider
 * whose registration, PKCE verifier and tokens persist — encrypted — through
 * `token-store.ts`. One-time browser sign-in is `pnpm orbio:auth`; after that
 * every process (`pnpm start`, `pnpm orbio:probe`, the M5b-2 lifecycle runner)
 * connects non-interactively and refreshes the access token on its own.
 *
 * The five wrappers below are the entire live surface Orbio exposes as of
 * 2026-09-09 (CHANGELOG "Session 2026-09-09"): the spec's `orbio_claim_key` /
 * `orbio_rotate_key` do not exist; `create_key` is claim-and-rotate in one and a
 * key holds no money — the account balance IS the quota. Each wrapper validates
 * the tool result with a zod schema calibrated to a recorded fixture under
 * `test/fixtures/orbio/`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import {
  loadEncryptionKey,
  readOAuthBlob,
  tokenStorePath,
  updateOAuthBlob,
} from './token-store';

const CLIENT_INFO = { name: 'launch-auditor', version: '0.0.0' } as const;
const DEFAULT_CALLBACK_PORT = 8976;

/** Thrown by {@link connectOrbio} when there is no usable token on disk. */
export class OrbioNotAuthedError extends Error {
  constructor(
    message = 'Orbio MCP is not authorized on this machine — run `pnpm orbio:auth` once.',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OrbioNotAuthedError';
  }
}

/** Raised when a connect would need an interactive browser sign-in but none is wired. */
export class OrbioInteractiveAuthRequired extends Error {
  constructor(public readonly authorizationUrl: URL) {
    super('Orbio OAuth requires an interactive browser sign-in.');
    this.name = 'OrbioInteractiveAuthRequired';
  }
}

export interface OrbioAuthProviderOptions {
  encryptionKey: Buffer;
  storePath: string;
  /** localhost port the browser redirect lands on (must match a registered redirect_uri) */
  callbackPort: number;
  /**
   * Interactive hook. Set by `pnpm orbio:auth` to open a browser. When absent,
   * a connect that needs sign-in throws {@link OrbioInteractiveAuthRequired}
   * instead of silently stalling.
   */
  onAuthorize?: (authorizationUrl: URL) => void | Promise<void>;
  /** hand the SDK the refresh_token (default false — see `tokens()`) */
  useRefreshToken?: boolean;
}

/**
 * File-backed {@link OAuthClientProvider}. All persisted state is one AES-256-GCM
 * blob (`token-store.ts`); nothing here is logged.
 */
export class OrbioAuthProvider implements OAuthClientProvider {
  constructor(private readonly opts: OrbioAuthProviderOptions) {}

  get redirectUrl(): string {
    return `http://localhost:${this.opts.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Launch Auditor',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readOAuthBlob(this.opts.storePath, this.opts.encryptionKey).clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    updateOAuthBlob(this.opts.storePath, this.opts.encryptionKey, { clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    const t = readOAuthBlob(this.opts.storePath, this.opts.encryptionKey).tokens;
    if (!t) return undefined;
    // 2026-09-12, measured: Orbio's refresh grant is ONE-SHOT. The first use
    // returns 200 with no replacement refresh_token; any later use of the same
    // token is 400 invalid_grant. The SDK only refreshes after a 401 and, on
    // invalid_grant, WIPES the stored tokens and demands a browser — so the
    // second refresh (~2h in) killed the overnight run, and a worker tick that
    // raced the interactive sign-in for the one refresh killed a fresh token
    // within a minute. Without a refresh_token the SDK never refreshes: a 401
    // means "re-auth needed", the access token (1h) stays on disk, and a race
    // self-heals. Cost: the unattended bound is one access lifetime, not two.
    // ORBIO_OAUTH_USE_REFRESH=1 trades that hour back for the destructive end.
    if (this.opts.useRefreshToken) return t;
    const { refresh_token: _dropped, ...rest } = t;
    return rest as OAuthTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    updateOAuthBlob(this.opts.storePath, this.opts.encryptionKey, { tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    // A non-interactive process (the worker) can never finish an authorize —
    // it throws OrbioInteractiveAuthRequired right after this — so persisting
    // its verifier only overwrites the one `pnpm orbio:auth` is waiting to use,
    // breaking the user's code exchange if a tick lands mid-sign-in. Keep it in
    // memory for the SDK's own bookkeeping; write to disk only when interactive.
    this.memoryVerifier = codeVerifier;
    if (!this.opts.onAuthorize) return;
    updateOAuthBlob(this.opts.storePath, this.opts.encryptionKey, { codeVerifier });
  }

  private memoryVerifier: string | undefined;

  codeVerifier(): string {
    const v = this.opts.onAuthorize
      ? readOAuthBlob(this.opts.storePath, this.opts.encryptionKey).codeVerifier
      : this.memoryVerifier;
    if (!v) throw new OrbioNotAuthedError('No PKCE code verifier on disk — restart `pnpm orbio:auth`.');
    return v;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.opts.onAuthorize) throw new OrbioInteractiveAuthRequired(authorizationUrl);
    await this.opts.onAuthorize(authorizationUrl);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const patch: Record<string, null> = {};
    if (scope === 'all' || scope === 'client') patch.clientInformation = null;
    if (scope === 'all' || scope === 'tokens') patch.tokens = null;
    if (scope === 'all' || scope === 'verifier') patch.codeVerifier = null;
    if (Object.keys(patch).length) {
      updateOAuthBlob(this.opts.storePath, this.opts.encryptionKey, patch);
    }
  }
}

/** Build an {@link OrbioAuthProvider} from `process.env`. */
export function orbioAuthProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: Pick<OrbioAuthProviderOptions, 'onAuthorize'> = {},
): OrbioAuthProvider {
  return new OrbioAuthProvider({
    encryptionKey: loadEncryptionKey(env.TOKEN_ENCRYPTION_KEY),
    storePath: tokenStorePath(env),
    callbackPort: Number(env.ORBIO_OAUTH_CALLBACK_PORT ?? DEFAULT_CALLBACK_PORT),
    onAuthorize: extra.onAuthorize,
    useRefreshToken: /^(1|true|yes)$/i.test(env.ORBIO_OAUTH_USE_REFRESH ?? ''),
  });
}

export function orbioMcpUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.ORBIO_MCP_URL?.trim();
  if (!raw) throw new Error('ORBIO_MCP_URL is not set');
  return new URL(raw);
}

export interface OrbioConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

/**
 * Connect to the Orbio MCP server. Non-interactive: if there is no token, or the
 * server rejects the token and sign-in would be needed, this throws
 * {@link OrbioNotAuthedError} (unless an `authProvider` with an `onAuthorize`
 * hook is supplied, as `pnpm orbio:auth` does).
 */
export async function connectOrbio(opts: {
  url?: URL;
  authProvider?: OAuthClientProvider;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<OrbioConnection> {
  const env = opts.env ?? process.env;
  const url = opts.url ?? orbioMcpUrl(env);
  const authProvider = opts.authProvider ?? orbioAuthProviderFromEnv(env);

  const transport = new StreamableHTTPClientTransport(url, { authProvider });
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof OrbioInteractiveAuthRequired) {
      // Say WHY, so the lifecycle log can tell "no token on disk" from "the
      // server rejected the token" — they need different responses.
      const hadToken = Boolean(authProvider.tokens ? await authProvider.tokens() : undefined);
      const why = hadToken
        ? 'stored token was rejected by the server (401) and refresh is disabled'
        : 'no token on disk';
      throw new OrbioNotAuthedError(
        `Orbio MCP is not authorized on this machine (${why}) — run \`pnpm orbio:auth\` once.`,
        { cause: err },
      );
    }
    throw err;
  }

  return {
    client,
    transport,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tool call plumbing
 * ──────────────────────────────────────────────────────────────────────────── */

export const ORBIO_TOOLS = [
  'orbio_get_balance',
  'orbio_create_key',
  'orbio_get_key_status',
  'orbio_revoke_key',
  'orbio_delete_key',
] as const;
export type OrbioToolName = (typeof ORBIO_TOOLS)[number];

/**
 * Pull the JSON payload out of an MCP `CallToolResult`: prefer `structuredContent`,
 * fall back to a single JSON text block. Throws on `isError`.
 */
export function extractToolPayload(result: unknown): unknown {
  const r = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const textBlocks = (r.content ?? []).filter((c) => c?.type === 'text' && typeof c.text === 'string');
  if (r.isError) {
    const msg = textBlocks.map((c) => c.text).join('\n') || 'Orbio tool returned isError with no text';
    throw new Error(`Orbio tool error: ${msg}`);
  }
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
  if (textBlocks.length === 1) {
    try {
      return JSON.parse(textBlocks[0]!.text!);
    } catch {
      return textBlocks[0]!.text;
    }
  }
  if (textBlocks.length > 1) return textBlocks.map((c) => c.text);
  return {};
}

/** Call an Orbio tool and return its raw (unvalidated) JSON payload. */
export async function callOrbioTool(
  client: Client,
  name: OrbioToolName,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  return extractToolPayload(result);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Typed, zod-validated wrappers
 *
 * Schemas are calibrated against the recorded fixtures in
 * `test/fixtures/orbio/*.json` (captured live 2026-09-09 by `pnpm orbio:probe`).
 * They validate every field the Metabolism state machine / budget policy reads
 * and `.passthrough()` the rest so an additive Orbio change does not break a
 * scored run.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Orbio's money shape, e.g. `{ "usd": 24.011879, "microUsd": "24011879" }`. */
const UsdAmount = z
  .object({ usd: z.number(), microUsd: z.string() })
  .passthrough();

/**
 * `orbio_get_balance {}` — `balance.usd` is the spendable quota:
 * `accrued + purchased + deposited − claimed − spent`. A key holds nothing.
 */
export const OrbioBalanceSchema = z
  .object({
    wallets: z.array(z.string()),
    accrued: UsdAmount,
    purchased: UsdAmount,
    deposited: UsdAmount,
    depositBalance: UsdAmount,
    depositFrozen: z.boolean(),
    spent: UsdAmount,
    claimed: UsdAmount,
    balance: UsdAmount,
  })
  .passthrough();
export type OrbioBalance = z.infer<typeof OrbioBalanceSchema>;

/**
 * `orbio_create_key { label?: string<=60 }` — mints a gateway key, full secret in
 * `key` shown ONCE, `replaced: true` when it retired an existing key (claim + rotate).
 */
export const OrbioCreateKeySchema = z
  .object({
    key: z.string().min(1),
    prefix: z.string(),
    baseUrl: z.string(),
    anthropicBaseUrl: z.string(),
    replaced: z.boolean(),
  })
  .passthrough();
export type OrbioCreateKey = z.infer<typeof OrbioCreateKeySchema>;

/** Legacy (pre-gateway) OpenRouter key summary, or `null` once it has been deleted. */
export const OrbioLegacyInfoSchema = z
  .object({
    label: z.string(),
    limitUsd: z.number(),
    usageUsd: z.number(),
    remainingUsd: z.number(),
    disabled: z.boolean(),
    readable: z.boolean(),
  })
  .passthrough();
export type OrbioLegacyInfo = z.infer<typeof OrbioLegacyInfoSchema>;

/** `orbio_get_key_status {}` — `prefix`/`createdAt` are null when `hasKey` is false. */
export const OrbioKeyStatusSchema = z
  .object({
    hasKey: z.boolean(),
    prefix: z.string().nullable(),
    createdAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    baseUrl: z.string(),
    anthropicBaseUrl: z.string(),
    legacy: OrbioLegacyInfoSchema.nullable(),
  })
  .passthrough();
export type OrbioKeyStatus = z.infer<typeof OrbioKeyStatusSchema>;

/** `orbio_revoke_key {}` — disables the current gateway key; account balance is untouched (no refund). */
export const OrbioRevokeKeySchema = z.object({ revoked: z.boolean() }).passthrough();
export type OrbioRevokeKey = z.infer<typeof OrbioRevokeKeySchema>;

/**
 * `orbio_delete_key {}` — legacy only, ONE-WAY: disables the pre-gateway OpenRouter
 * key and returns its unspent balance (`refunded`) to the account.
 */
export const OrbioDeleteKeySchema = z
  .object({
    refunded: UsdAmount,
    label: z.string(),
  })
  .passthrough();
export type OrbioDeleteKey = z.infer<typeof OrbioDeleteKeySchema>;

const LABEL_MAX = 60;

export function validateOrbioBalance(payload: unknown): OrbioBalance {
  return OrbioBalanceSchema.parse(payload);
}
export function validateOrbioCreateKey(payload: unknown): OrbioCreateKey {
  return OrbioCreateKeySchema.parse(payload);
}
export function validateOrbioKeyStatus(payload: unknown): OrbioKeyStatus {
  return OrbioKeyStatusSchema.parse(payload);
}
export function validateOrbioRevokeKey(payload: unknown): OrbioRevokeKey {
  return OrbioRevokeKeySchema.parse(payload);
}
export function validateOrbioDeleteKey(payload: unknown): OrbioDeleteKey {
  return OrbioDeleteKeySchema.parse(payload);
}

export async function orbioGetBalance(client: Client): Promise<OrbioBalance> {
  return validateOrbioBalance(await callOrbioTool(client, 'orbio_get_balance', {}));
}

export async function orbioCreateKey(
  client: Client,
  opts: { label?: string } = {},
): Promise<OrbioCreateKey> {
  const args: Record<string, unknown> = {};
  if (opts.label !== undefined) {
    if (opts.label.length > LABEL_MAX) {
      throw new Error(`orbio_create_key label must be <= ${LABEL_MAX} chars (got ${opts.label.length})`);
    }
    args.label = opts.label;
  }
  return validateOrbioCreateKey(await callOrbioTool(client, 'orbio_create_key', args));
}

export async function orbioGetKeyStatus(client: Client): Promise<OrbioKeyStatus> {
  return validateOrbioKeyStatus(await callOrbioTool(client, 'orbio_get_key_status', {}));
}

export async function orbioRevokeKey(client: Client): Promise<OrbioRevokeKey> {
  return validateOrbioRevokeKey(await callOrbioTool(client, 'orbio_revoke_key', {}));
}

export async function orbioDeleteKey(client: Client): Promise<OrbioDeleteKey> {
  return validateOrbioDeleteKey(await callOrbioTool(client, 'orbio_delete_key', {}));
}
