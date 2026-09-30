import { describe, it, expect } from 'vitest';
import { columnFor } from './store';
import type { Bead } from '@overseer/shared';

const bead = (p: Partial<Bead>): Bead => ({ id: 'b', title: 't', description: '', status: 'open', priority: 2, labels: [], notes: '', assignee: null, closed_at: null, dependency_count: 0, ...p });

describe('columnFor', () => {
  const ready = new Set(['b']);
  it('closed wins', () => expect(columnFor(bead({ status: 'closed', labels: ['overseer:review'] }), ready)).toBe('done'));
  it('phase labels beat status', () => {
    expect(columnFor(bead({ status: 'in_progress', labels: ['overseer:verifying'] }), ready)).toBe('verifying');
    expect(columnFor(bead({ status: 'in_progress', labels: ['overseer:review'] }), ready)).toBe('review');
  });
  it('in_progress is running', () => expect(columnFor(bead({ status: 'in_progress' }), ready)).toBe('running'));
  it('open splits on readiness', () => {
    expect(columnFor(bead({ status: 'open' }), ready)).toBe('ready');
    expect(columnFor(bead({ status: 'open' }), new Set())).toBe('blocked');
    expect(columnFor(bead({ status: 'open', labels: ['overseer:rejected'] }), ready)).toBe('ready');
  });
});
