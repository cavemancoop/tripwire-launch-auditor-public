import { getGetLogsMaxRange } from '@launch-auditor/chain';
import type { PublicClient } from 'viem';
import { recordFailure } from '../failures';
import { loadEnv } from '../env';
import { POOLS_STREAM, getCursor, setCursor } from './cursor';
import { detectPools, type DetectedPool } from './detect';
import { ingestPool } from './ingest';
import { isTransientRpcError } from './retry';

export interface PollResult {
  from: bigint;
  to: bigint;
  poolsSeen: number;
  launchesIndexed: number;
  failed: number;
  cursorAdvanced: boolean;
}

export interface PollOptions {
  chainId?: number;
  /** first run with no cursor: start at head (live) vs block 0 (full history) */
  startAtHeadIfEmpty?: boolean;
  /** cap blocks advanced in one call, for bounded replay / catch-up progress */
  maxSpan?: bigint;
  /**
   * Stop holding the cursor for pools that fail at or below this block — log the
   * tx hash and skip them. The runPoller escape hatch when a window is wedged.
   */
  abandonFailuresThroughBlock?: bigint;
}

/**
 * Advance the pool-creation cursor once: read new logs up to a settled head,
 * ingest each pool as a `launches` row, persist the new cursor.
 *
 * A single pool that can't be ingested (transient RPC miss, bad data) must not
 * abort the batch: failures are caught per-pool, and the cursor is held just
 * before the earliest failed block so that range is retried next poll.
 */
export async function pollOnce(
  client: PublicClient,
  opts: PollOptions = {},
): Promise<PollResult> {
  const env = loadEnv();
  const chainId = opts.chainId ?? env.chainId;

  const head = await client.getBlockNumber();
  const safeHead = head > env.headLagBlocks ? head - env.headLagBlocks : 0n;

  let cursor = await getCursor(chainId, POOLS_STREAM);
  if (cursor === null) {
    cursor = (opts.startAtHeadIfEmpty ?? true) ? safeHead : 0n;
    await setCursor(chainId, POOLS_STREAM, cursor);
  }
  if (cursor >= safeHead) {
    return { from: cursor, to: cursor, poolsSeen: 0, launchesIndexed: 0, failed: 0, cursorAdvanced: false };
  }

  const from = cursor + 1n;
  const to =
    opts.maxSpan && from + opts.maxSpan - 1n < safeHead
      ? from + opts.maxSpan - 1n
      : safeHead;

  const detected = await detectPools(client, chainId, from, to, getGetLogsMaxRange(chainId));

  let launchesIndexed = 0;
  let failed = 0;
  let earliestHeldFailure: bigint | null = null;

  for (const dp of detected) {
    try {
      const id = await ingestPool(dp, {
        client,
        chainId,
        quotaPerCreator24h: env.quotaPerCreator24h,
      });
      if (id) launchesIndexed += 1;
    } catch (err) {
      failed += 1;
      const abandon =
        opts.abandonFailuresThroughBlock !== undefined &&
        dp.blockNumber <= opts.abandonFailuresThroughBlock;
      logIngestFailure(dp, err, abandon);
      if (!abandon && (earliestHeldFailure === null || dp.blockNumber < earliestHeldFailure)) {
        earliestHeldFailure = dp.blockNumber;
      }
    }
  }

  const nextCursor = earliestHeldFailure !== null ? earliestHeldFailure - 1n : to;
  await setCursor(chainId, POOLS_STREAM, nextCursor);

  return {
    from,
    to: nextCursor,
    poolsSeen: detected.length,
    launchesIndexed,
    failed,
    cursorAdvanced: nextCursor > cursor,
  };
}

function logIngestFailure(dp: DetectedPool, err: unknown, abandoned: boolean): void {
  const head = err instanceof Error ? err.message.split('\n')[0] : String(err);
  const where = `block ${dp.blockNumber} tx ${dp.txHash}`;
  if (abandoned) {
    // eslint-disable-next-line no-console
    console.error(`[watcher] ABANDONING pool at ${where} after repeated failure — recover with \`pnpm watcher:replay --from ${dp.blockNumber}\`: ${head}`);
    void recordFailure('watcher.pool_abandoned', err);
  } else if (isTransientRpcError(err)) {
    // eslint-disable-next-line no-console
    console.warn(`[watcher] transient ingest miss at ${where}, will retry: ${head}`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[watcher] ingest error at ${where}: ${head}`);
    void recordFailure('watcher.ingest_error', err);
  }
}

export interface StopSignal {
  stopped: boolean;
}

const STUCK_POLLS_BEFORE_SKIP = 6;

export async function runPoller(client: PublicClient, signal: StopSignal): Promise<void> {
  const { pollIntervalMs, maxSpanBlocks } = loadEnv();
  let stuckPolls = 0;

  while (!signal.stopped) {
    try {
      const abandonThrough =
        stuckPolls >= STUCK_POLLS_BEFORE_SKIP
          ? (await getCursor(loadEnv().chainId, POOLS_STREAM)) ?? undefined
          : undefined;
      const shiftedAbandon =
        abandonThrough !== undefined ? abandonThrough + maxSpanBlocks : undefined;

      const r = await pollOnce(client, {
        maxSpan: maxSpanBlocks,
        abandonFailuresThroughBlock: shiftedAbandon,
      });

      if (r.poolsSeen > 0 || r.failed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[watcher] ${r.from}-${r.to}: ${r.poolsSeen} pools, ${r.launchesIndexed} new` +
            (r.failed ? `, ${r.failed} failed` : ''),
        );
      }

      if (r.cursorAdvanced) {
        stuckPolls = 0;
      } else if (r.failed > 0) {
        stuckPolls += 1;
        if (stuckPolls === STUCK_POLLS_BEFORE_SKIP) {
          // eslint-disable-next-line no-console
          console.warn(
            `[watcher] cursor stalled for ${stuckPolls} polls — next poll will abandon unrecoverable pools in this window (replayable)`,
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[watcher] poll error', err instanceof Error ? err.message : err);
      await recordFailure('watcher.poll_error', err);
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
}
