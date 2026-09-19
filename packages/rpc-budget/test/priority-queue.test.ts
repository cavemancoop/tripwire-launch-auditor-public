import { describe, expect, it } from 'vitest';
import { PriorityQueue } from '../src/priority-queue';

describe('PriorityQueue', () => {
  it('drains lowest priority number first, FIFO within a tier', () => {
    const q = new PriorityQueue<string>();
    q.push(2, 'a');
    q.push(0, 'b');
    q.push(2, 'c');
    q.push(1, 'd');
    q.push(0, 'e');

    const out: string[] = [];
    while (q.size > 0) out.push(q.shift()!);
    expect(out).toEqual(['b', 'e', 'd', 'a', 'c']);
  });

  it('peekPriority reflects the head', () => {
    const q = new PriorityQueue<number>();
    expect(q.peekPriority()).toBeUndefined();
    q.push(5, 1);
    q.push(3, 2);
    expect(q.peekPriority()).toBe(3);
    q.shift();
    expect(q.peekPriority()).toBe(5);
  });

  it('shift on empty is undefined', () => {
    expect(new PriorityQueue<number>().shift()).toBeUndefined();
  });
});
