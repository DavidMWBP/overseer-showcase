import { describe, it, expect } from 'vitest';
import type { BoardResponse } from '@overseer/shared';
import { board } from '../test/fixtures';
import { ApiError } from '../api';
import { boardLoaded, boardRequested, jobAccepted, jobEnded, jobRefused, pendingFor, sendAction, startJob, whenJobEnds } from './jobs';

const result = (job_id: string, ok = true) => ({ job_id, action: 'verify', target: 'ov-6', ok, message: ok ? null : 'exit 1', data: null });
/** The fixture board with the given job on ov-6's card (null: nothing runs for it). */
const boardWith = (jobId: string | null): BoardResponse => ({
  ...board,
  repos: board.repos.map((r) => ({ ...r, cards: r.cards.map((c) => (c.bead.id === 'ov-6' ? { ...c, pending_action: jobId ? { job_id: jobId, action: 'verify', started_at: '2026-09-13T00:00:00.000Z' } : null } : c)) })),
});

describe('jobs', () => {
  it('holds a target from the click, and refuses a second click for it', () => {
    expect(startJob('ov-6', 'verify')).toBe(true);
    expect(pendingFor('ov-6')).toBe('verify');
    expect(startJob('ov-6', 'redispatch')).toBe(false);
    expect(pendingFor('ov-6')).toBe('verify');
    // Another target is not held by it.
    expect(startJob('ov-7', 'close')).toBe(true);
  });

  it('keeps the pending state after the 202 until the job ends', () => {
    startJob('ov-6', 'verify');
    jobAccepted('ov-6', 'j1');
    expect(pendingFor('ov-6')).toBe('verify');
    jobEnded(result('j2')); // another job's end
    expect(pendingFor('ov-6')).toBe('verify');
    jobEnded(result('j1', false));
    expect(pendingFor('ov-6')).toBeNull();
  });

  it('drops the target when the job ended before its 202 or 409 was read', () => {
    startJob('ov-6', 'verify');
    jobEnded(result('j1'));
    jobAccepted('ov-6', 'j1');
    expect(pendingFor('ov-6')).toBeNull();
  });

  it('holds a target a 409 refused under the action the daemon says runs, not the one clicked', async () => {
    const sent = await sendAction('ov-6', 'abandon', async () => { throw new ApiError(409, 'merge is already running for ov-6', { error: 'merge is already running for ov-6', job_id: 'j1', action: 'merge' }); });
    expect(sent).toEqual({ jobId: 'j1', ours: false });
    expect(pendingFor('ov-6')).toBe('merge');
    jobEnded({ ...result('j1'), action: 'merge' });
    expect(pendingFor('ov-6')).toBeNull();
  });

  it('drops a refused request at once', () => {
    startJob('ov-6', 'verify');
    jobRefused('ov-6');
    expect(pendingFor('ov-6')).toBeNull();
  });

  it('settles on a board requested after the 202 whose row carries no job', () => {
    startJob('ov-6', 'verify');
    const before = boardRequested(); // in flight when the 202 is read: its row predates the job
    jobAccepted('ov-6', 'j1');
    boardLoaded(boardWith(null), before);
    expect(pendingFor('ov-6')).toBe('verify');
    const after = boardRequested();
    boardLoaded(boardWith('j1'), after); // the job is running
    expect(pendingFor('ov-6')).toBe('verify');
    boardLoaded(boardWith(null), boardRequested()); // it ended while the result was missed (a restart, a dropped socket)
    expect(pendingFor('ov-6')).toBeNull();
  });

  it('leaves a click whose request has not answered to the answer, whatever the board says', () => {
    startJob('ov-6', 'verify');
    boardLoaded(boardWith(null), boardRequested());
    expect(pendingFor('ov-6')).toBe('verify');
  });

  it('calls a watcher once with the result, at once when the job already ended', () => {
    const seen: boolean[] = [];
    whenJobEnds('j1', (r) => seen.push(r.ok));
    jobEnded(result('j1', false));
    jobEnded(result('j1', false));
    expect(seen).toEqual([false]);
    whenJobEnds('j1', (r) => seen.push(r.ok));
    expect(seen).toEqual([false, false]);
  });
});
