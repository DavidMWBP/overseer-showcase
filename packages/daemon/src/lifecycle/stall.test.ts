import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { mkTmpRepo } from '../test/tmpgit';
import { openDb, type Db } from '../db/db';
import { sweepStalls, startStallSweep, WORKTREE_CHECK_MS, type StallDeps, type SeenStalls, type WorktreeChecks } from './stall';
import type { SessionRow } from '@overseer/shared';

const MINUTE = 60_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('stall detection', () => {
  let db: Db;
  let notices: { text: string; hint?: string }[];
  let stalled: string[][];
  let deps: StallDeps;
  let seen: SeenStalls;

  beforeEach(() => {
    db = openDb(':memory:');
    notices = [];
    stalled = [];
    deps = {
      db,
      stallMs: 15 * MINUTE,
      notify: async (text, opts) => { notices.push({ text, ...(opts?.hint ? { hint: opts.hint } : {}) }); },
      onStalled: (ids) => stalled.push(ids),
    };
    seen = new Map();
    db.repos.insert({ id: 'r1', path: '/tmp/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 2 });
  });

  /** A running session of `role` on `bead`, started `startedMsAgo` ago. */
  function session(id: string, o: Partial<SessionRow> & { startedMsAgo: number }): void {
    db.sessions.insert({
      id, harness: 'codex', role: 'worker', bead_id: 'ov-1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null,
      start_commit: null, cwd: '/tmp/wt', status: 'running', started_at: at(o.startedMsAgo), ended_at: null, cost: null, batch_id: null,
      log_path: null, log_offset: 0, tier: 'standard', model: 'gpt-5.6-terra', ...o,
    });
  }

  /** An event on `id` recorded `msAgo` ago; the sweep reads the latest one as the session's last sign of life. */
  function event(id: string, type: string, msAgo: number, payload: unknown = null): void {
    const row = db.events.append(id, type, payload);
    db.sql.prepare('UPDATE events SET ts=? WHERE id=?').run(at(msAgo), row.id);
  }

  it('reports a worker that has been silent past the threshold, with its idle minutes and last message', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE });
    event('s1', 'assistant_text', 16 * MINUTE, { text: 'Running the test suite.' });

    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('ov-1');
    expect(notices[0]!.text).toContain('16 minutes');
    expect(notices[0]!.text).toContain('Running the test suite.');
    expect(notices[0]!.hint).toContain('worker_status');
  });

  it('tells the orchestrator that an opencode session ends a silent turn by itself at the silence limit', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE, harness: 'opencode', model: 'deepseek/deepseek-v4-flash' });
    session('s2', { startedMsAgo: 40 * MINUTE, bead_id: 'ov-2' });

    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(2);
    const hintOf = (bead: string) => notices.find((n) => n.text.startsWith(bead))!.hint;
    expect(hintOf('ov-1')).toContain("opencode adapter ends a turn that prints nothing for 20 minutes after its last event and after every running tool call's own timeout by itself");
    expect(hintOf('ov-2')).not.toContain('opencode adapter');
  });

  it('does not report a worker that is still active', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE });
    event('s1', 'tool_call', 2 * MINUTE);

    await sweepStalls(deps, seen);

    expect(notices).toEqual([]);
  });

  it('reports one stall once, however often the sweep runs', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE });
    event('s1', 'tool_call', 16 * MINUTE);

    await sweepStalls(deps, seen);
    await sweepStalls(deps, seen);
    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(1);
  });

  it('reports again when the worker woke up and then went silent a second time', async () => {
    session('s1', { startedMsAgo: 60 * MINUTE });
    event('s1', 'tool_call', 40 * MINUTE);
    await sweepStalls(deps, seen);
    expect(notices).toHaveLength(1);

    event('s1', 'tool_call', 16 * MINUTE); // it woke up, then fell silent again
    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(2);
  });

  it('falls back to the start time for a session that has recorded no events at all', async () => {
    session('s1', { startedMsAgo: 20 * MINUTE });

    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('20 minutes');
  });

  it('reports a stalled critic as well as a worker', async () => {
    session('s1', { role: 'critic', startedMsAgo: 40 * MINUTE });
    event('s1', 'tool_call', 16 * MINUTE);

    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('critic');
  });

  it('never reports the orchestrator session, which is idle between messages by design', async () => {
    session('s1', { role: 'orchestrator', bead_id: null, startedMsAgo: 10 * 60 * MINUTE });

    await sweepStalls(deps, seen);

    expect(notices).toEqual([]);
  });

  it('hands the office feed the ids of every session currently stalled', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE });
    session('s2', { startedMsAgo: 40 * MINUTE, bead_id: 'ov-2' });
    event('s2', 'tool_call', 2 * MINUTE); // s2 is still active

    await sweepStalls(deps, seen);

    expect(stalled.at(-1)).toEqual(['s1']);
  });

  it('hands an empty set when nothing is stalled, so a cleared mark is published', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE });
    event('s1', 'tool_call', 2 * MINUTE);

    await sweepStalls(deps, seen);

    expect(stalled.at(-1)).toEqual([]);
  });

  it('hands an empty set on the sweep after a stalled session wakes up', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE });
    event('s1', 'tool_call', 16 * MINUTE);
    await sweepStalls(deps, seen);
    expect(stalled.at(-1)).toEqual(['s1']);

    seen.clear();
    event('s1', 'tool_call', 1 * MINUTE); // it woke up, so the later sweep no longer finds it stalled
    await sweepStalls(deps, seen);

    expect(stalled.at(-1)).toEqual([]);
  });

  it('never names the orchestrator among the stalled ids', async () => {
    session('s1', { role: 'orchestrator', bead_id: null, startedMsAgo: 10 * 60 * MINUTE });

    await sweepStalls(deps, seen);

    expect(stalled.at(-1)).toEqual([]);
  });

  it('does not report a session that has already ended', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE, status: 'ended', ended_at: at(20 * MINUTE) });

    await sweepStalls(deps, seen);

    expect(notices).toEqual([]);
  });

  /** A real repo whose one changed file was last written `msAgo` ago; the session's cwd points at it. */
  function worktree(msAgo: number): string {
    const repo = mkTmpRepo('ov-stall-').path;
    const file = path.join(repo, 'README.md');
    fs.writeFileSync(file, '# changed\n');
    const t = new Date(Date.now() - msAgo);
    fs.utimesSync(file, t, t);
    return repo;
  }

  it('does not report a session whose log is quiet while its worktree changed recently', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE, cwd: worktree(30_000) });
    event('s1', 'tool_call', 16 * MINUTE);

    await sweepStalls(deps, seen);

    expect(notices).toEqual([]);
  });

  it('reports a session whose log and worktree are both quiet, and says the worktree is quiet too', async () => {
    session('s1', { startedMsAgo: 40 * MINUTE, cwd: worktree(20 * MINUTE) });
    event('s1', 'tool_call', 16 * MINUTE);

    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('16 minutes');
    expect(notices[0]!.text).toContain('its worktree has not changed for 20 minutes');
  });

  it('names worktree activity newer than the log in the notice', async () => {
    session('s1', { startedMsAgo: 60 * MINUTE, cwd: worktree(17 * MINUTE) });
    event('s1', 'tool_call', 40 * MINUTE);

    await sweepStalls(deps, seen);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('quiet log for 40 minutes, but the worktree changed 17 minutes ago; a sub-agent may be working');
  });

  it('checks a worktree at most once per interval', async () => {
    const cwd = worktree(20 * MINUTE);
    session('s1', { startedMsAgo: 40 * MINUTE, cwd });
    event('s1', 'tool_call', 16 * MINUTE);
    const checks: WorktreeChecks = new Map();
    await sweepStalls(deps, seen, checks);
    expect(notices).toHaveLength(1);

    fs.writeFileSync(path.join(cwd, 'README.md'), '# changed again\n'); // fresh activity the cached check does not see yet
    seen.clear();
    await sweepStalls(deps, seen, checks);
    expect(notices).toHaveLength(2);

    checks.get('s1')!.at -= WORKTREE_CHECK_MS; // the interval has passed
    seen.clear();
    await sweepStalls(deps, seen, checks);
    expect(notices).toHaveLength(2);
  });

  it('starts no timer when the threshold is zero', () => {
    expect(startStallSweep({ ...deps, stallMs: 0 })).toBeNull();
  });

  it('starts a timer that does not hold the process open', () => {
    const stop = startStallSweep(deps);
    expect(stop).not.toBeNull();
    stop!();
  });
});
