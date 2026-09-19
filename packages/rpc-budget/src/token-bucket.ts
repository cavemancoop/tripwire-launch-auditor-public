/**
 * A refilling token bucket. One token = one permitted RPC request.
 *
 * `capacity` is the burst allowance; `refillPerSec` the sustained rate. The
 * clock is injectable so the scheduler tests can run without real time.
 */
export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  /** ms clock; defaults to Date.now */
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly now: () => number;

  constructor(private readonly opts: TokenBucketOptions) {
    if (opts.capacity <= 0) throw new Error('TokenBucket: capacity must be > 0');
    if (opts.refillPerSec <= 0) throw new Error('TokenBucket: refillPerSec must be > 0');
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsed * this.opts.refillPerSec);
    this.last = t;
  }

  /** Take `n` tokens if available. Returns true on success. */
  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens + 1e-9 >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** ms until `n` tokens are available (0 if available now). */
  msUntilAvailable(n = 1): number {
    this.refill();
    if (this.tokens + 1e-9 >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.opts.refillPerSec) * 1000);
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}
