/**
 * A load-balanced RPC can serve `eth_getLogs` from a node a few seconds ahead of
 * the node that then answers `getTransaction` / `getBlock`, so a just-seen tx or
 * block reads back as "not found". Shallow reorgs look the same. These are
 * transient: back off and retry.
 */

const TRANSIENT_MESSAGE =
  /could not be found|not be processed on a block yet|not found|rate.?limit|too many requests|429|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network is busy|exceeds defined limit|try again in a moment|-32005|-32000/i;

const TRANSIENT_NAME =
  /NotFoundError|TimeoutError|HttpRequestError|RpcRequestError|LimitExceededError/i;

export function isTransientRpcError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const name = 'name' in err ? String((err as { name?: unknown }).name ?? '') : '';
    if (TRANSIENT_NAME.test(name)) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_MESSAGE.test(msg);
}

export interface RetryOptions {
  tries?: number;
  /** base delay; grows linearly per attempt */
  delayMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const tries = opts.tries ?? 4;
  const delayMs = opts.delayMs ?? 1500;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === tries - 1) throw err;
      await new Promise((res) => setTimeout(res, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

export class DeadlineError extends Error {
  constructor(ms: number, label?: string) {
    super(`deadline of ${ms}ms exceeded${label ? ` for ${label}` : ''}`);
    this.name = 'DeadlineError';
  }
}

/**
 * Reject with {@link DeadlineError} if `fn` has not settled within `ms`. The
 * underlying promise is not cancelled (JS can't) but the shared RPC scheduler
 * rate-limits whatever it's doing, so it settles and is GC'd soon after. Use
 * this to stop one pathological launch / outcome from stalling a whole backfill
 * — the earlier 24h "hang" was one T+10m scan waiting forever on a dead socket.
 */
export function withDeadline<T>(fn: () => Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(ms, label)), ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
