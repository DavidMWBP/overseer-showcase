import { describe, it, expect } from 'vitest';
import { MemoryTaskStore } from './memory';

describe('MemoryTaskStore.create', () => {
  it('creates a bead with its labels and blockers and answers its id', async () => {
    const s = new MemoryTaskStore();
    s.add('/r', { id: 'ov-1', title: 'First' });
    const id = await s.create('/r', { title: 'Second', description: 'd', labels: ['overseer:batch:r1-b1'], blockedBy: ['ov-1'] });
    const bead = await s.show('/r', id);
    expect(bead).toMatchObject({ title: 'Second', description: 'd', labels: ['overseer:batch:r1-b1'] });
    expect(await s.blocked('/r')).toEqual([{ id, blocked_by: ['ov-1'] }]);
  });
  it('fails for the title a test names', async () => {
    const s = new MemoryTaskStore();
    s.failCreate = 'Second';
    await expect(s.create('/r', { title: 'Second', description: '', labels: [], blockedBy: [] })).rejects.toThrow(/Second/);
  });
});
