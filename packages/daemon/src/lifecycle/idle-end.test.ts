import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type Db } from '../db/db';
import { sweepIdleEnds, startIdleEndSweep, type IdleEndDeps } from './idle-end';
import type { SessionRow } from '@overseer/shared';
import { SessionManager, type SessionEnded } from '../sessions/manager';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import type { SessionHandle } from '../harness/types';
import os from 'node:os';
import path from 'node:path';

const MINUTE = 60_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('idle-end detection', () => {
  let db: Db;
  let ended: string[];
  let deps: IdleEndDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
    db = openDb(':memory:');
    ended = [];
    deps = {
      db,
      idleEndMs: 3 * MINUTE,
      end: async (id) => { ended.push(id); },
    };
    db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', worker_limit: 3, review_rounds: 2, batch_approver: 'user' });
  });

  afterEach(() => {
    db.sql.close();
    vi.useRealTimers();
  });

  /** A running worker session started `startedMsAgo` ago. */
  function session(id: string, o: Partial<SessionRow> & { startedMsAgo: number }): void {
    db.sessions.insert({
      id, harness: 'codex', role: 'worker', bead_id: 'ov-1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null,
      start_commit: null, cwd: '/tmp/wt', status: 'running', started_at: at(o.startedMsAgo), ended_at: null, cost: null, batch_id: null,
      log_path: null, log_offset: 0, tier: 'standard', model: 'gpt-5.6-terra', ...o,
    });
  }

  /** An event on `id` recorded `msAgo` ago. */
  function event(id: string, type: string, msAgo: number, payload: unknown = null): void {
    const row = db.events.append(id, type, payload);
    db.sql.prepare('UPDATE events SET ts=? WHERE id=?').run(at(msAgo), row.id);
  }

  it('ends a worker idle past the threshold after a turn end with a non-empty final message', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 4 * MINUTE, { text: 'Final report: done.' });
    event('s1', 'turn_end', 4 * MINUTE);

    await sweepIdleEnds(deps);

    expect(ended).toEqual(['s1']);
  });

  it('does not end a worker still inside the threshold', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 1 * MINUTE, { text: 'Final report: done.' });
    event('s1', 'turn_end', 1 * MINUTE);

    await sweepIdleEnds(deps);

    expect(ended).toEqual([]);
  });

  it('resets the timer when activity follows the turn end', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 10 * MINUTE, { text: 'Final report: done.' });
    event('s1', 'turn_end', 10 * MINUTE);
    event('s1', 'tool_call', 2 * MINUTE);
    event('s1', 'assistant_text', 1 * MINUTE, { text: 'Updated final report.' });
    event('s1', 'turn_end', 1 * MINUTE);

    await sweepIdleEnds(deps);
    expect(ended).toEqual([]);

    vi.advanceTimersByTime(2 * MINUTE);
    await sweepIdleEnds(deps);
    expect(ended).toEqual(['s1']);
  });

  it('does not end a session with no final message', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'turn_end', 10 * MINUTE);

    await sweepIdleEnds(deps);

    expect(ended).toEqual([]);
  });

  it('does not reuse a final message from an earlier turn when the latest turn has none', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 15 * MINUTE, { text: 'Earlier result.' });
    event('s1', 'turn_end', 15 * MINUTE);
    event('s1', 'tool_call', 11 * MINUTE);
    event('s1', 'turn_end', 10 * MINUTE);

    await sweepIdleEnds(deps);

    expect(ended).toEqual([]);
  });

  it('leaves a session that never reached a turn end to the stall sweep', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'tool_call', 10 * MINUTE);

    await sweepIdleEnds(deps);

    expect(ended).toEqual([]);
  });

  it('startIdleEndSweep runs no sweep when the threshold is 0', () => {
    const stop = startIdleEndSweep({ ...deps, idleEndMs: 0 }, 1000);
    expect(stop).toBeNull();
  });

  it('sweepIdleEnds itself does nothing when the threshold is 0', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 20 * MINUTE, { text: 'Final report: done.' });
    event('s1', 'turn_end', 20 * MINUTE);

    await sweepIdleEnds({ ...deps, idleEndMs: 0 });

    expect(ended).toEqual([]);
  });

  it('does not end a session a message was just sent to, even past the threshold', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 10 * MINUTE, { text: 'Final report: done.' });
    event('s1', 'turn_end', 10 * MINUTE);
    event('s1', 'message', 5 * MINUTE, { text: 'still there?' });

    await sweepIdleEnds(deps);

    expect(ended).toEqual([]);
  });

  it('ignores a sub-agent event carrying a parentId when finding the latest event', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });
    event('s1', 'assistant_text', 10 * MINUTE, { text: 'Final report: done.' });
    event('s1', 'turn_end', 10 * MINUTE);
    event('s1', 'assistant_text', 1 * MINUTE, { text: 'sub-agent note', parentId: 'call_task' });

    await sweepIdleEnds(deps);

    expect(ended).toEqual(['s1']);
  });
});

/** A real-adapter stand-in: its handle is gone after `end`, but the event stream stays open until the process closes it. */
class LateEndAdapter extends FakeAdapter {
  private ended = new Set<string>();
  override async end(h: SessionHandle): Promise<void> {
    if (this.ended.has(h.id)) throw new Error(`fake session ${h.id} not found`);
    this.ended.add(h.id);
  }
  close(h: SessionHandle): void { this.sessions.get(h.id)!.queue.close(); }
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('idle-end through a real session manager', () => {
  it('a late turn_end after the sweep ended the session leaves it ended, not failed', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const adapter = new LateEndAdapter();
    const mgr = new SessionManager(db, { claude: adapter }, bus, path.join(os.tmpdir(), 'overseer-test-idle-end'));
    const s = mgr.start({ role: 'worker', harness: 'claude', repoId: 'r1', beadId: 'ov-1', cwd: '/tmp/wt', prompt: 'go' });
    const h = mgr.handleOf(s.id)!;
    // A message queued mid-turn means this turn end is decremented, not acted on: the worker idles on its own final report.
    await mgr.send(s.id, 'still there?');
    adapter.emit(h, { type: 'assistant_text', text: 'Final report: done.' });
    adapter.emit(h, { type: 'turn_end', nativeSessionId: 'n1' });
    const ended = new Promise<SessionEnded>((r) => bus.once('session:ended', r));
    // The sweep skips a turn end younger than idleEndMs, and the clock has millisecond resolution.
    await until(() => { const last = db.events.last(s.id); return last?.type === 'turn_end' && Date.now() - Date.parse(last.ts) >= 1; });
    await sweepIdleEnds({ db, idleEndMs: 1, end: (id) => mgr.end(id) });
    // The turn's closing event is read after the sweep already ended the session's handle.
    adapter.emit(h, { type: 'turn_end', nativeSessionId: 'n1' });
    adapter.close(h);
    const e = await ended;
    expect(e.session.status).toBe('ended');
    expect(db.sessions.get(s.id)).toMatchObject({ status: 'ended', end_reason: null });
  });
});
