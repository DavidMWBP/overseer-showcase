import { describe, it, expect } from 'vitest';
import { EventQueue } from './queue';

describe('EventQueue', () => {
  it('yields in order and ends on close', async () => {
    const q = new EventQueue<number>();
    q.push(1); q.push(2);
    setTimeout(() => { q.push(3); q.close(); }, 5);
    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([1, 2, 3]);
  });
});
