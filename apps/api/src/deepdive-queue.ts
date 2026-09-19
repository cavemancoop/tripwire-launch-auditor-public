/**
 * Producer side of the `deepdive` BullMQ queue (spec §9 `POST /v1/deepdive/{token}`).
 * The worker's `startDeepdiveWorker` consumes these jobs. Queue name is the wire
 * contract with `apps/worker/src/queues.ts` — keep them in sync.
 */
import { Queue } from 'bullmq';

export const DEEPDIVE_QUEUE = 'deepdive';

export interface DeepdiveJob {
  tokenAddress: string;
  trigger: 'on_demand';
}

export type DeepdiveEnqueuer = (job: DeepdiveJob) => Promise<{ id: string | undefined }>;

function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const u = new URL(url);
  const cfg: { host: string; port: number; password?: string } = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
  };
  if (u.password) cfg.password = u.password;
  return cfg;
}

/** Real enqueuer backed by BullMQ. Lazily opens one connection. */
export function makeDeepdiveEnqueuer(redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'): DeepdiveEnqueuer {
  let queue: Queue | undefined;
  return async (job) => {
    queue ??= new Queue(DEEPDIVE_QUEUE, { connection: parseRedisUrl(redisUrl) });
    const added = await queue.add('deepdive', job, {
      jobId: `${job.tokenAddress.toLowerCase()}:${job.trigger}`,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return { id: added.id };
  };
}
