/**
 * Stable priority queue: lowest `priority` number comes out first; within one
 * priority, insertion order (FIFO). Sizes here are small (hundreds at most), so a
 * linear insertion keeps it simple and allocation-free per shift.
 */
interface Entry<T> {
  priority: number;
  seq: number;
  value: T;
}

export class PriorityQueue<T> {
  private items: Entry<T>[] = [];
  private seq = 0;

  push(priority: number, value: T): void {
    const entry: Entry<T> = { priority, seq: this.seq++, value };
    let i = this.items.length;
    // walk left past every entry that should stay ahead of this one
    while (i > 0) {
      const prev = this.items[i - 1]!;
      if (prev.priority <= priority) break;
      i--;
    }
    this.items.splice(i, 0, entry);
  }

  shift(): T | undefined {
    return this.items.shift()?.value;
  }

  get size(): number {
    return this.items.length;
  }

  /** priority of the next item to come out, or undefined if empty */
  peekPriority(): number | undefined {
    return this.items[0]?.priority;
  }
}
