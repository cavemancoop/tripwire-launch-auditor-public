import { PriorityQueue } from './priority-queue';
import { TokenBucket } from './token-bucket';

export interface SchedulerOptions {
  /** sustained requests per minute (token refill rate) */
  rpm: number;
  /** burst capacity; default max(ceil(rpm/10), 10) */
  burst?: number;
  /** max concurrent in-flight requests; default 12 */
  maxInFlight?: number;
  /** injectable timers/clock for tests */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface Job {
  priority: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export interface SchedulerStats {
  enqueued: number;
  started: number;
  completed: number;
  failed: number;
  inFlight: number;
  queued: number;
  /** count started, per priority tier */
  byPriority: Record<number, number>;
}

/**
 * One instance per RPC URL, shared by every client that talks to it. Requests
 * are admitted in priority order, throttled by a token bucket, and capped at
 * `maxInFlight` concurrently.
 */
export class RequestScheduler {
  private readonly bucket: TokenBucket;
  private readonly queue = new PriorityQueue<Job>();
  private readonly maxInFlight: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private inFlight = 0;
  private timer: unknown;
  private pumping = false;

  private readonly counts = {
    enqueued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    byPriority: {} as Record<number, number>,
  };

  constructor(opts: SchedulerOptions) {
    const burst = opts.burst ?? Math.max(Math.ceil(opts.rpm / 30), 3);
    this.bucket = new TokenBucket({
      capacity: burst,
      refillPerSec: opts.rpm / 60,
      now: opts.now,
    });
    this.maxInFlight = opts.maxInFlight ?? 12;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  }

  schedule<T>(priority: number, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(priority, {
        priority,
        run: run as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.counts.enqueued++;
      this.pump();
    });
  }

  get stats(): SchedulerStats {
    return {
      enqueued: this.counts.enqueued,
      started: this.counts.started,
      completed: this.counts.completed,
      failed: this.counts.failed,
      inFlight: this.inFlight,
      queued: this.queue.size,
      byPriority: { ...this.counts.byPriority },
    };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    // let the current synchronous caller finish before we start draining
    queueMicrotask(() => {
      this.pumping = false;
      this.loop();
    });
  }

  private loop(): void {
    while (this.queue.size > 0 && this.inFlight < this.maxInFlight) {
      if (!this.bucket.tryTake()) {
        const wait = Math.max(this.bucket.msUntilAvailable(), 5);
        if (this.timer === undefined) {
          this.timer = this.setTimeoutFn(() => {
            this.timer = undefined;
            this.loop();
          }, wait);
        }
        return;
      }
      const job = this.queue.shift();
      if (!job) return;
      this.inFlight++;
      this.counts.started++;
      this.counts.byPriority[job.priority] = (this.counts.byPriority[job.priority] ?? 0) + 1;
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    try {
      const value = await job.run();
      this.counts.completed++;
      job.resolve(value);
    } catch (err) {
      this.counts.failed++;
      job.reject(err);
    } finally {
      this.inFlight--;
      this.loop();
    }
  }
}
