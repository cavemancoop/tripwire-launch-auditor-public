import { numberToHex } from 'viem';

export interface ProbeOptions {
  /** a contract address with plenty of logs (e.g. the v4 PoolManager) */
  address: string;
  /** recent block to anchor the probe window at (usually head - a few) */
  anchorBlock: bigint;
  /** spans to try, largest first; first that the RPC accepts wins */
  candidates?: number[];
  /** topic filter — keep this to a sparse event (e.g. Initialize) so the probe
   *  response is small; an unfiltered scan of a busy contract can hang the RPC */
  topics?: (string | string[] | null)[];
}

const TRANSIENT = /busy|try again|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|429|socket hang up/i;

type RequestFn = (args: { method: string; params: unknown[] }) => Promise<unknown>;

/**
 * Find the largest eth_getLogs block span this RPC will answer. Tries the
 * candidates largest-first; a span that errors (range limit *or* a transient) is
 * retried once for transients, then the next-smaller span is tried. Returns the
 * smallest candidate if none succeed — conservative, never optimistic.
 */
export async function probeGetLogsRange(request: RequestFn, opts: ProbeOptions): Promise<number> {
  const candidates = (opts.candidates ?? [20_000, 10_000, 5_000, 2_000, 1_000])
    .slice()
    .sort((a, b) => b - a);
  const safest = candidates[candidates.length - 1] ?? 2_000;

  for (const span of candidates) {
    const from = opts.anchorBlock - BigInt(span) + 1n;
    const params = [
      {
        address: opts.address,
        ...(opts.topics ? { topics: opts.topics } : {}),
        fromBlock: numberToHex(from < 0n ? 0n : from),
        toBlock: numberToHex(opts.anchorBlock),
      },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await request({ method: 'eth_getLogs', params });
        return span;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && TRANSIENT.test(msg)) {
          await new Promise((r) => setTimeout(r, 1_000));
          continue; // retry the same span once
        }
        break; // try the next smaller span
      }
    }
  }
  return safest;
}
