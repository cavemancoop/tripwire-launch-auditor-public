/**
 * Response cache for RPC calls whose answer cannot change once given: reads
 * pinned to a concrete block or a tx/block hash. Anything referencing a moving
 * tag (`latest`, `pending`, `safe`, `finalized`) or with no block at all
 * (`eth_blockNumber`, `eth_gasPrice`, …) is never cached.
 *
 * Keyed by chainId + method + a stable stringification of params, so two callers
 * asking the same historical question share one RPC hit — the single biggest
 * lever on staying under the rate limit during the M4 backfill.
 */
const IMMUTABLE_METHODS = new Set([
  'eth_chainId',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getStorageAt',
  'eth_call',
  'eth_getLogs',
]);

const MOVING_TAG = /"(latest|pending|safe|finalized|earliest)"/;

/** true when this method+params pair is safe to cache forever. */
export function isCacheable(method: string, params: unknown): boolean {
  if (!IMMUTABLE_METHODS.has(method)) return false;
  const json = stableStringify(params);
  if (MOVING_TAG.test(json)) return false;

  if (method === 'eth_getLogs') {
    const p = Array.isArray(params) ? (params[0] as Record<string, unknown> | undefined) : undefined;
    const toBlock = p?.['toBlock'];
    // open-ended (defaults to latest) — not safe
    if (typeof toBlock !== 'string' || !toBlock.startsWith('0x')) return false;
    return true;
  }

  if (
    method === 'eth_getCode' ||
    method === 'eth_getBalance' ||
    method === 'eth_getTransactionCount' ||
    method === 'eth_call' ||
    method === 'eth_getStorageAt' ||
    method === 'eth_getBlockByNumber'
  ) {
    const arr = Array.isArray(params) ? params : [];
    const blockArg = arr[arr.length - 1];
    if (typeof blockArg !== 'string' || !blockArg.startsWith('0x')) return false;
    return true;
  }

  // hash-addressed reads: always safe
  return true;
}

export function cacheKey(chainId: number, method: string, params: unknown): string | null {
  if (!isCacheable(method, params)) return null;
  return `${chainId}|${method}|${stableStringify(params)}`;
}

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Bounded FIFO cache. Immutable values, so eviction order barely matters. */
export class ResponseCache {
  private map = new Map<string, unknown>();
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 20_000) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): unknown {
    const hit = this.map.has(key);
    if (hit) this.hits++;
    else this.misses++;
    return this.map.get(key);
  }

  set(key: string, value: unknown): void {
    if (this.map.has(key)) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}
