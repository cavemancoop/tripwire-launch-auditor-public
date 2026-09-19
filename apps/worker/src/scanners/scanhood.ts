// ScanHood — purpose-built safety/analytics API for Robinhood Chain (4663).
// GET https://scanhood.xyz/api/scan?token=  and  /api/quote?token=&side=&amount=
// No auth; ~5 req/s per IP. Reachable from a plain server fetch (not Cloudflare-gated).

export interface ScanHoodScan {
  verdict?: 'PASS' | 'CAUTION' | 'DANGER';
  sellable?: boolean | null; // honeypot simulation
  roundTripLossPct?: number | null;
  verified?: boolean | null;
  launchpad?: string | null;
  rwa?: 'official' | 'impostor' | 'unverified' | null;
  contractTemplate?: string | null;
  lp?: {
    type?: string;
    status?: string;
    safe?: boolean | null;
    detail?: string;
  } | null;
  deployer?: {
    address?: string;
    launched?: number;
    risk?: string;
    label?: string;
  } | null;
  market?: {
    pool?: string;
    dex?: string;
    priceUsd?: number | null;
    liq?: number | null;
    mcap?: number | null;
    vol24?: number | null;
  } | null;
  flags?: Array<{ level: string; msg?: string; message?: string }>;
  scanned_at?: number;
  [k: string]: unknown;
}

export interface ScanHoodQuote {
  side?: 'buy' | 'sell';
  amountIn?: string;
  amountOut?: string;
  venue?: string;
  error?: string;
  [k: string]: unknown;
}

export interface ScanHoodResult<T> {
  ok: boolean;
  data: T | null;
  raw: unknown;
  fetchedAt: Date;
}

export interface ScanHoodOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function get<T>(url: string, f: typeof fetch): Promise<ScanHoodResult<T>> {
  const fetchedAt = new Date();
  try {
    const res = await f(url, { headers: { accept: 'application/json' } });
    const raw = (await res.json()) as T & { error?: string };
    return { ok: res.ok && !raw?.error, data: raw, raw, fetchedAt };
  } catch (err) {
    return { ok: false, data: null, raw: { error: String(err) }, fetchedAt };
  }
}

export function fetchScanHoodScan(
  token: string,
  opts: ScanHoodOptions = {},
): Promise<ScanHoodResult<ScanHoodScan>> {
  const base = opts.baseUrl ?? 'https://scanhood.xyz';
  return get<ScanHoodScan>(
    `${base}/api/scan?token=${token.toLowerCase()}`,
    opts.fetchImpl ?? fetch,
  );
}

export function fetchScanHoodQuote(
  token: string,
  side: 'buy' | 'sell',
  amount: string | number,
  opts: ScanHoodOptions = {},
): Promise<ScanHoodResult<ScanHoodQuote>> {
  const base = opts.baseUrl ?? 'https://scanhood.xyz';
  return get<ScanHoodQuote>(
    `${base}/api/quote?token=${token.toLowerCase()}&side=${side}&amount=${amount}`,
    opts.fetchImpl ?? fetch,
  );
}

export interface ScanHoodMapped {
  verified: boolean | null;
  sellable: boolean | null;
  lpHolderType: string | null;
  liquidityUsd: number | null;
  deployerLaunched: number | null;
  isImpostorRwa: boolean | null;
}

export function mapScanHood(s: ScanHoodScan | null): ScanHoodMapped {
  if (!s) {
    return {
      verified: null,
      sellable: null,
      lpHolderType: null,
      liquidityUsd: null,
      deployerLaunched: null,
      isImpostorRwa: null,
    };
  }
  return {
    verified: s.verified ?? null,
    sellable: s.sellable ?? null,
    lpHolderType: s.lp?.status && s.lp.status !== 'unknown' ? s.lp.status : (s.lp?.type ?? null),
    liquidityUsd: s.market?.liq ?? null,
    deployerLaunched: s.deployer?.launched ?? null,
    isImpostorRwa: s.rwa == null ? null : s.rwa === 'impostor',
  };
}
