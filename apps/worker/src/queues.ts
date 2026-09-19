import { Queue } from 'bullmq';
import { loadEnv } from './env';

/** Job queues for the pipeline (spec §3). Populated by later milestones. */
export const QUEUE_NAMES = {
  watcher: 'watcher', // M1: event discovery + index-lane features
  features: 'features', // M1/M2: T+10m and qualified-lane features
  outcomes: 'outcomes', // M4: outcome resolution at each horizon
  commits: 'commits', // M3: Merkle root batching + on-chain post
  deepdive: 'deepdive', // M6: llm_deepdive_v0
  metabolism: 'metabolism', // M5: Orbio key lifecycle
  assess: 'assess', // M7: POST /v1/assess/{token} — on-demand det_v0/heuristic_v1 report
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
}

/** Parse REDIS_URL into the shape BullMQ's `connection` option accepts. */
export function parseRedisUrl(url: string): RedisConnectionConfig {
  const parsed = new URL(url);
  const config: RedisConnectionConfig = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
  };
  if (parsed.password) config.password = parsed.password;
  return config;
}

/** T+10m delay for the second-pass feature job (spec §3.3 items 4-7). */
export const T10_DELAY_MS = 10 * 60 * 1000;

let queues: { features: Queue } | undefined;

export function getQueues(): { features: Queue } {
  if (!queues) {
    const connection = parseRedisUrl(loadEnv().redisUrl);
    queues = { features: new Queue(QUEUE_NAMES.features, { connection }) };
  }
  return queues;
}

export async function closeQueues(): Promise<void> {
  if (queues) {
    await queues.features.close();
    queues = undefined;
  }
}
