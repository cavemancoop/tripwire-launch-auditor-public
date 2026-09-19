// GoPlus Token Security API for chain 4663 (confirmed in their supported_chains).
// No key needed for token_security; a key raises rate limits. Data is often thin
// for very fresh tokens — every field is optional.

export interface GoPlusTokenSecurity {
  is_open_source?: string; // "1" = verified source
  is_mintable?: string; // "1" = mintable
  is_honeypot?: string; // "1" = honeypot
  cannot_sell_all?: string; // "1" = can't dump full balance
  owner_address?: string;
  can_take_back_ownership?: string; // "1" = ownership reclaimable
  hidden_owner?: string;
  transfer_pausable?: string;
  is_proxy?: string;
  buy_tax?: string; // decimal fraction as string, e.g. "0.05"
  sell_tax?: string;
  lp_holders?: Array<{ address: string; is_locked?: number; percent?: string; tag?: string }>;
  token_name?: string;
  token_symbol?: string;
  [k: string]: unknown;
}

export interface GoPlusResult {
  ok: boolean;
  security: GoPlusTokenSecurity | null;
  raw: unknown;
  fetchedAt: Date;
}

export interface GoPlusOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  chainId?: number;
}

export async function fetchGoPlus(
  token: string,
  opts: GoPlusOptions = {},
): Promise<GoPlusResult> {
  const base = opts.baseUrl ?? 'https://api.gopluslabs.io/api/v1';
  const f = opts.fetchImpl ?? fetch;
  const chainId = opts.chainId ?? 4663;
  const addr = token.toLowerCase();
  const fetchedAt = new Date();
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.apiKey) headers.Authorization = opts.apiKey;
    const res = await f(
      `${base}/token_security/${chainId}?contract_addresses=${addr}`,
      { headers },
    );
    const raw = (await res.json()) as {
      code?: number;
      result?: Record<string, GoPlusTokenSecurity>;
    };
    const security = raw?.result?.[addr] ?? null;
    return { ok: raw?.code === 1 && security !== null, security, raw, fetchedAt };
  } catch (err) {
    return { ok: false, security: null, raw: { error: String(err) }, fetchedAt };
  }
}

const isOne = (v: string | undefined): boolean | null =>
  v === undefined || v === '' ? null : v === '1';

/** Decimal-fraction tax string ("0.05") -> basis points (500). */
export function taxToBps(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10_000) : null;
}

export interface GoPlusMapped {
  verified: boolean | null;
  mintable: boolean | null;
  honeypot: boolean | null;
  ownerRenounced: boolean | null;
  sellTaxBps: number | null;
  lpLocked: boolean | null;
}

export function mapGoPlus(s: GoPlusTokenSecurity | null): GoPlusMapped {
  if (!s) {
    return {
      verified: null,
      mintable: null,
      honeypot: null,
      ownerRenounced: null,
      sellTaxBps: null,
      lpLocked: null,
    };
  }
  const owner = (s.owner_address ?? '').toLowerCase();
  const ownerGone =
    owner === '' || owner === '0x0000000000000000000000000000000000000000';
  const lp = s.lp_holders ?? [];
  const lpLocked = lp.length
    ? lp.some((h) => h.is_locked === 1 || (h.tag ?? '').toLowerCase().includes('lock'))
    : null;
  return {
    verified: isOne(s.is_open_source),
    mintable: isOne(s.is_mintable),
    honeypot: isOne(s.is_honeypot),
    ownerRenounced: ownerGone && isOne(s.can_take_back_ownership) !== true ? true : ownerGone ? null : false,
    sellTaxBps: taxToBps(s.sell_tax),
    lpLocked,
  };
}
