import { describe, expect, it } from 'vitest';
import type { OrchestratorActivity } from '@overseer/shared';
import { MASCOT_SLEEP_MS, mascotFor, type MascotActivity } from './mascotFor';

const now = Date.parse('2026-09-15T12:00:00.000Z');
const base: MascotActivity = { activity: null, contextPercentage: 47, lastActivityAt: new Date(now).toISOString(), pendingQuestion: false, sessionLive: true, offline: false };
const thinking: OrchestratorActivity = { state: 'thinking', tool: null, summary: null, started_at: new Date(now).toISOString() };

describe('mascotFor', () => {
  it.each([
    ['asking', { pendingQuestion: true }],
    ['thinking', { activity: thinking }],
    ['working', { activity: { ...thinking, state: 'tool' as const, tool: 'Bash', summary: 'running checks' } }],
    ['idle', {}],
    ['sleeping', { sessionLive: false }],
    ['offline', { offline: true }],
    ['error', { sessionStatus: 'failed' as const }],
  ])('maps %s state', (state, change) => expect(mascotFor({ ...base, ...change }, now).state).toBe(state));

  it.each([[39, 'high'], [40, 'normal'], [75, 'normal'], [76, 'low']] as const)('maps %s%% context to %s energy', (context, energy) => {
    expect(mascotFor({ ...base, contextPercentage: context }, now).energy).toBe(energy);
  });

  it('sleeps only after ten minutes without activity', () => {
    expect(mascotFor({ ...base, lastActivityAt: new Date(now - MASCOT_SLEEP_MS).toISOString() }, now).state).toBe('idle');
    expect(mascotFor({ ...base, lastActivityAt: new Date(now - MASCOT_SLEEP_MS - 1).toISOString() }, now).state).toBe('sleeping');
  });

  it('keeps the status label with the context percentage', () => {
    expect(mascotFor({ ...base, activity: thinking }, now).label).toBe('orchestrator: thinking, context 47%');
  });

  it('keeps the established labels for idle and tool activity', () => {
    const tool: OrchestratorActivity = { ...thinking, state: 'tool', tool: 'Bash', summary: 'running checks' };
    expect([
      mascotFor(base, now).label,
      mascotFor({ ...base, activity: tool }, now).label,
    ]).toEqual(['orchestrator: idle, context 47%', 'orchestrator: running checks, context 47%']);
  });
});
