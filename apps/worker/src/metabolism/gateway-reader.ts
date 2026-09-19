import { z } from 'zod';

/**
 * Balance, lifetime spend and key identity straight from the Orbio gateway,
 * authenticated by the gateway key itself — no MCP session.
 *
 * `GET {gateway}/key` (Orbio "for agents" §5, confirmed live 2026-09-16):
 * `balance.available` is the activated AI balance the key can still spend
 * (a 402 `insufficient_quota` follows when it is 0); `balance.used` is lifetime
 * usage — the provider's own spend figure, which is what the M5c epoch
 * reconciliation needs. Money is an exact decimal string.
 *
 * This replaces `orbio_get_balance` + `orbio_get_key_status` for reading. It
 * cannot create or revoke keys (the protocol's keys are wallet signatures, not
 * minted objects), so the gateway source always runs key management in observe
 * mode.
 */

const Money = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal money string');

export const GatewayKeySchema = z
  .object({
    key: z
      .object({
        prefix: z.string(),
        label: z.string().nullable().optional(),
        created_at: z.string().nullable().optional(),
      })
      .passthrough(),
    balance: z
      .object({
        currency: z.literal('USD'),
        available: Money,
        used: Money,
      })
      .passthrough(),
    rate_limit: z
      .object({ requests_per_minute: z.number(), concurrent: z.number() })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GatewayKey = z.infer<typeof GatewayKeySchema>;

/** What the lifecycle runner reads each tick, whichever source it came from. */
export interface MetabolismReading {
  balanceUsd: number;
  providerSpendUsd: number;
  status: { hasKey: boolean; prefix: string | null; createdAt: string | null };
}

export function gatewayKeyToReading(k: GatewayKey): MetabolismReading {
  return {
    balanceUsd: Number(k.balance.available),
    providerSpendUsd: Number(k.balance.used),
    status: { hasKey: true, prefix: k.key.prefix, createdAt: k.key.created_at ?? null },
  };
}

export async function gatewayGetKey(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<GatewayKey> {
  if (!opts.apiKey) throw new Error('gateway balance read: no gateway key (set ORBIO_API_KEY)');
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/key`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`gateway GET /key -> ${res.status}: ${body.slice(0, 200)}`);
  return GatewayKeySchema.parse(JSON.parse(body));
}

export type MetabolismSource = 'gateway' | 'mcp';

/**
 * `gateway` (default): read from `GET /key` with the gateway key — works
 * unattended, forever. `mcp`: the original OAuth session path, kept for key
 * management experiments. Orbio (2026-09-16): "reduce relying on MCP".
 */
export function metabolismSource(env: NodeJS.ProcessEnv = process.env): MetabolismSource {
  return env.METABOLISM_SOURCE?.trim().toLowerCase() === 'mcp' ? 'mcp' : 'gateway';
}
