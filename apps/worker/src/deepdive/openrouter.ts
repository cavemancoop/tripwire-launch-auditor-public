/**
 * OpenRouter client for `llm_deepdive_v0`, pointed at the Orbio gateway.
 *
 * - base URL: `ORBIO_GATEWAY_V1_URL` (OpenAI-shape, from `orbio_get_key_status`)
 * - key: the Metabolism-minted gateway key (persisted encrypted by the M5b
 *   lifecycle runner), falling back to `ORBIO_API_KEY` / `OPENROUTER_API_KEY`
 * - attribution headers (`HTTP-Referer`, `X-Title`) on every call (CLAUDE.md)
 *
 * Cost per call is read back from `GET /generation?id=` and recorded into the
 * `MetabolismSpend` ledger (M5b-3) — wired at the call site in M6b.
 */
import { OpenRouter } from '@openrouter/agent';
import { loadEnv, type WorkerEnv } from '../env';
import {
  loadEncryptionKey,
  readOAuthBlob,
  tokenStorePath,
} from '../metabolism/token-store';

let walletKey: string | null = null;

/** Set at worker boot when ORBIO_KEY_SOURCE=wallet: the agent wallet's signature key. */
export function setWalletGatewayKey(key: string | null): void {
  walletKey = key;
}

export const walletGatewayKeyActive = (): boolean => walletKey !== null;

/** Resolve the gateway key: wallet signature → encrypted store → ORBIO_API_KEY → OPENROUTER_API_KEY. */
export function resolveGatewayKey(env: NodeJS.ProcessEnv = process.env): string {
  if (walletKey) return walletKey;
  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      const blob = readOAuthBlob(tokenStorePath(env), loadEncryptionKey(env.TOKEN_ENCRYPTION_KEY));
      if (blob.gatewayKey) return blob.gatewayKey;
    } catch {
      // fall through to env keys
    }
  }
  return env.ORBIO_API_KEY || env.OPENROUTER_API_KEY || '';
}

export interface DeepdiveClientDeps {
  /** override key resolution (tests) */
  resolveKey?: () => string;
}

export interface DeepdiveClient {
  openrouter: OpenRouter;
  model: string;
  /** the referer / title actually sent, for the report's provenance */
  attribution: { httpReferer: string; xTitle: string };
  baseUrl: string;
}

export function createDeepdiveClient(
  env: WorkerEnv = loadEnv(),
  deps: DeepdiveClientDeps = {},
): DeepdiveClient {
  const resolveKey = deps.resolveKey ?? (() => resolveGatewayKey());
  const openrouter = new OpenRouter({
    apiKey: async () => {
      const k = resolveKey();
      if (!k) throw new Error('deep-dive: no gateway key (run `pnpm orbio:auth` / set ORBIO_API_KEY)');
      return k;
    },
    serverURL: env.orbioGatewayV1Url,
    httpReferer: env.openrouterHttpReferer || undefined,
    appTitle: env.openrouterXTitle || undefined,
  });
  return {
    openrouter,
    model: env.openrouterModelDeepdive,
    attribution: { httpReferer: env.openrouterHttpReferer, xTitle: env.openrouterXTitle },
    baseUrl: env.orbioGatewayV1Url,
  };
}

/** Assert a scored forecaster is using a pinned, identifiable model (spec §5 / CLAUDE.md). */
export function assertScoredModelSlug(slug: string): void {
  if (!slug) throw new Error('OPENROUTER_MODEL_DEEPDIVE is not set — a scored run needs a pinned exact slug');
  if (/~latest|:latest|openrouter\/auto|\bauto\b/i.test(slug)) {
    throw new Error(`OPENROUTER_MODEL_DEEPDIVE="${slug}" — a scored forecaster may not use ~latest / openrouter/auto (the model must be identifiable per report)`);
  }
}

export interface GenerationCost {
  id: string;
  totalCostUsd: number;
  model: string | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  raw: unknown;
}

export interface GenerationCostDeps {
  fetchImpl?: typeof fetch;
  resolveKey?: () => string;
  baseUrl?: string;
}

/**
 * `GET /generation?id=` — the authoritative per-call cost (the streamed `usage`
 * is an estimate). Called after each deep-dive turn; the result feeds
 * `recordSpend` (M5b-3).
 */
export async function generationCost(
  id: string,
  env: WorkerEnv = loadEnv(),
  deps: GenerationCostDeps = {},
): Promise<GenerationCost> {
  const f = deps.fetchImpl ?? fetch;
  const key = (deps.resolveKey ?? (() => resolveGatewayKey()))();
  const base = deps.baseUrl ?? env.orbioGatewayV1Url;
  const res = await f(`${base.replace(/\/$/, '')}/generation?id=${encodeURIComponent(id)}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) {
    throw new Error(`generation lookup ${id}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: Record<string, unknown> } | Record<string, unknown>;
  const d = (('data' in body && body.data) || body) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id,
    totalCostUsd: num(d.total_cost) ?? num(d.usage) ?? 0,
    model: typeof d.model === 'string' ? d.model : null,
    tokensPrompt: num(d.tokens_prompt) ?? num(d.native_tokens_prompt),
    tokensCompletion: num(d.tokens_completion) ?? num(d.native_tokens_completion),
    raw: body,
  };
}
