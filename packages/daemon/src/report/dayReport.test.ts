import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BatchSignalKind, Repo, SessionRow, WorktreeRow } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { mkTmpRepo, sh } from '../test/tmpgit';
import { buildDayReport, deregisteredWorktrees, dayBounds, renderDayReport } from './dayReport';

const DAY = '2026-09-18';
const at = (hour: number) => `${DAY}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function setup(): { db: Db; repo: Repo; worktreesDir: string } {
  const t = mkTmpRepo('ov-day-report-');
  roots.push(path.dirname(t.path));
  const db = openDb(':memory:', { batchIdSuffix: () => '' });
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 2, model_filter: null };
  db.repos.insert(repo);
  return { db, repo, worktreesDir: t.worktreesDir };
}

function addSession(db: Db, overrides: Partial<SessionRow> & Pick<SessionRow, 'id' | 'started_at'>): void {
  const row: SessionRow = {
    id: overrides.id,
    harness: 'claude', role: 'worker', bead_id: null, repo_id: 'r1', native_session_id: null, pid: null,
    pid_started_at: null, start_commit: null, cwd: '/wt', status: 'ended', started_at: overrides.started_at,
    ended_at: null, cost: null, tier: null, model: null, batch_id: null, log_path: null, log_offset: 0,
  };
  db.sessions.insert({ ...row, ...overrides });
}

function addBatch(db: Db, id: string, repoId = 'r1'): void {
  db.batches.insert({ id, repo_id: repoId, title: id, branch: `feature/${id}`, base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: at(0), updated_at: at(0), merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
}

function addSignal(db: Db, kind: BatchSignalKind, beadId: string, text: string, ts: string, batchId = 'r1-b1'): void {
  const row = db.signals.insert({ batch_id: batchId, bead_id: beadId, kind, text });
  db.sql.prepare('UPDATE batch_signals SET ts=? WHERE id=?').run(ts, row.id);
}

function addWorktree(db: Db, beadId: string, overrides: Partial<WorktreeRow> = {}): void {
  db.worktrees.upsert({
    bead_id: beadId, repo_id: 'r1', path: `/wt/${beadId}`, branch: `bead/${beadId}`, base_branch: 'main',
    verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null,
    batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, ...overrides,
  });
}

describe('day report', () => {
  it('counts every counter for one repo and day and names the beads above each threshold', async () => {
    const x = setup();
    addBatch(x.db, 'r1-b1');
    addBatch(x.db, 'r1-b2');
    // Workers ending without commits: only the no_commits reopen proves it. An uncommitted-changes reopen is excluded (the
    // branch already had work to land) and a usage-limit stop is excluded (it does not say whether the worker committed).
    addSignal(x.db, 'reopen', 'ov-1', 'no_commits: no output', at(9));
    addSignal(x.db, 'reopen', 'ov-1', 'uncommitted_changes: modified: a.ts', at(10));
    addSignal(x.db, 'reopen', 'ov-2', 'no_commits: exited with code 1', at(9));
    addSignal(x.db, 'reopen', 'ov-3', 'stopped: account x hit its usage limit', at(9));
    // Re-dispatches: ov-4 four times (above three), ov-5 once.
    for (let i = 0; i < 4; i++) addSignal(x.db, 'redispatch', 'ov-4', '', at(11));
    addSignal(x.db, 'redispatch', 'ov-5', '', at(11));
    // Closes as won't do.
    addSignal(x.db, 'closed', 'ov-8', 'not needed', at(12));
    addSignal(x.db, 'closed', 'ov-9', '', at(12));
    // Outside the day, and another repo: neither is counted.
    addSignal(x.db, 'reopen', 'ov-99', 'no_commits: yesterday', '2026-09-17T09:00:00.000Z');
    const other: Repo = { ...x.repo, id: 'r2', path: `${x.repo.path}-other` };
    x.db.repos.insert(other);
    addBatch(x.db, 'r2-b1', 'r2');
    addSignal(x.db, 'reopen', 'ov-200', 'no_commits: other repo', at(9), 'r2-b1');
    addSignal(x.db, 'redispatch', 'ov-201', '', at(9), 'r2-b1');

    // Review rounds come from critic sessions started that day; a worker and a previous-day critic are not rounds.
    addWorktree(x.db, 'ov-4');
    addWorktree(x.db, 'ov-5');
    for (let i = 0; i < 3; i++) addSession(x.db, { id: `crit-ov-4-${i}`, role: 'critic', bead_id: 'ov-4', started_at: at(10 + i), cost: 0.1 });
    addSession(x.db, { id: 'crit-ov-5', role: 'critic', bead_id: 'ov-5', started_at: at(10), cost: 0.1 });
    addSession(x.db, { id: 'crit-ov-4-yesterday', role: 'critic', bead_id: 'ov-4', started_at: '2026-09-17T10:00:00.000Z', cost: 99 });
    addSession(x.db, { id: 'worker-ov-4', role: 'worker', bead_id: 'ov-4', started_at: at(9), cost: 1 });
    addSession(x.db, { id: 'worker-unknown', role: 'worker', bead_id: 'ov-2', started_at: at(9) });

    // Landed: ov-6 with open findings, ov-7 clean, ov-8 on another day (excluded).
    addWorktree(x.db, 'ov-2');
    addWorktree(x.db, 'ov-6', { merged_at: at(13), accepted_note: 'landed with open findings' });
    addWorktree(x.db, 'ov-7', { merged_at: at(14) });
    addWorktree(x.db, 'ov-8', { merged_at: '2026-09-17T13:00:00.000Z' });

    const r = await buildDayReport(x.db, x.repo, DAY, x.worktreesDir);

    expect(r.workers_no_commits).toEqual({ total: 2, by_bead: [{ bead_id: 'ov-1', count: 1 }, { bead_id: 'ov-2', count: 1 }] });
    expect(r.redispatches).toEqual({ total: 5, by_bead: [{ bead_id: 'ov-4', count: 4 }, { bead_id: 'ov-5', count: 1 }], above_threshold: ['ov-4'] });
    expect(r.review_rounds).toEqual({ total: 4, by_bead: [{ bead_id: 'ov-4', count: 3 }, { bead_id: 'ov-5', count: 1 }], above_threshold: ['ov-4'] });
    expect(r.landed_with_open_findings).toEqual({ total: 1, beads: ['ov-6'] });
    expect(r.closed_wont_do).toEqual({ total: 2, beads: ['ov-8', 'ov-9'] });
    expect(r.cost).toEqual({ reported: 1.4, unknown_sessions: 1, landed_beads: 2, per_landed_bead: 0.7 });
    expect(r.deregistered_worktrees).toEqual({ count: 0, bytes: 0, paths: [] });

    expect(renderDayReport(r)).toBe([
      'Day report for r1 on 2026-09-18',
      'workers ending without commits: 2 (ov-1 x1, ov-2 x1)',
      're-dispatches: 5 (ov-4 x4, ov-5 x1); above 3 (ov-4)',
      'review rounds: 4 (ov-4 x3, ov-5 x1); above 2 (ov-4)',
      'landed with open findings: 1 (ov-6)',
      "closed as won't do: 2 (ov-8, ov-9)",
      'cost: reported $1.40 (1 session without one); 2 beads landed, $0.70 per landed bead',
      'deregistered worktrees: 0 dirs, 0 B',
    ].join('\n'));
  });

  it('renders zeros for a day with nothing to report', async () => {
    const x = setup();
    addBatch(x.db, 'r1-b1');
    addSession(x.db, { id: 'other-day', started_at: at(9), cost: 0.5 });
    const r = await buildDayReport(x.db, x.repo, '2000-01-01', x.worktreesDir);
    expect(r.workers_no_commits.total).toBe(0);
    expect(r.redispatches.total).toBe(0);
    expect(r.review_rounds.total).toBe(0);
    expect(r.landed_with_open_findings.total).toBe(0);
    expect(r.closed_wont_do.total).toBe(0);
    expect(r.cost).toEqual({ reported: 0, unknown_sessions: 0, landed_beads: 0, per_landed_bead: null });
    expect(r.deregistered_worktrees).toEqual({ count: 0, bytes: 0, paths: [] });
    expect(renderDayReport(r)).toBe([
      'Day report for r1 on 2000-01-01',
      'workers ending without commits: 0',
      're-dispatches: 0; above 3',
      'review rounds: 0; above 2',
      'landed with open findings: 0',
      "closed as won't do: 0",
      'cost: reported $0.00 (0 sessions without one); 0 beads landed, n/a per landed bead',
      'deregistered worktrees: 0 dirs, 0 B',
    ].join('\n'));
  });

  it('counts a landed bead whose row still holds review findings', async () => {
    const x = setup();
    addWorktree(x.db, 'ov-1', { merged_at: at(13), review_findings: [{ file: 'a.ts', summary: 'fix it', severity: 'must' }] });
    const r = await buildDayReport(x.db, x.repo, DAY, x.worktreesDir);
    expect(r.landed_with_open_findings).toEqual({ total: 1, beads: ['ov-1'] });
  });

  it('does not count a verified close as a won\'t-do close', async () => {
    const x = setup();
    addWorktree(x.db, 'ov-1', { closed_at: at(13) });
    const r = await buildDayReport(x.db, x.repo, DAY, x.worktreesDir);
    expect(r.closed_wont_do.total).toBe(0);
  });

  it('sums only the worktree folders git no longer lists', async () => {
    const x = setup();
    const repoDir = path.join(x.worktreesDir, 'r1');
    fs.mkdirSync(repoDir, { recursive: true });
    const live = path.join(repoDir, 'live');
    sh(x.repo.path, ['worktree', 'add', '-b', 'live-branch', live]);
    const orphan = path.join(repoDir, 'orphan');
    fs.mkdirSync(path.join(orphan, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(orphan, 'a.bin'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(orphan, 'nested', 'b.bin'), Buffer.alloc(500));

    expect(await deregisteredWorktrees(x.repo, x.worktreesDir)).toEqual({ count: 1, bytes: 1500, paths: [orphan] });
    const r = await buildDayReport(x.db, x.repo, DAY, x.worktreesDir);
    expect(r.deregistered_worktrees).toEqual({ count: 1, bytes: 1500, paths: [orphan] });
    expect(renderDayReport(r)).toContain('deregistered worktrees: 1 dir, 1.46 KB');
  });

  it('bounds a day in UTC and rejects a malformed date', () => {
    expect(dayBounds('2026-09-18')).toEqual({ from: '2026-09-18T00:00:00.000Z', to: '2026-09-19T00:00:00.000Z' });
    expect(() => dayBounds('2026-9-18')).toThrow(/invalid day/);
  });
});
