import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BatchSignalKind, Repo } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { log } from '../util/log';
import { REDISPATCH_THRESHOLD, REVIEW_ROUND_THRESHOLD, type DayReport } from './dayReport';
import { msUntilNextLocalHour, NO_COMMIT_THRESHOLD, ORPHAN_BYTES_THRESHOLD, runNightlyReport, startNightlyReport, thresholdNotice, utcDayBefore } from './nightly';

const DAY = '2026-09-18';
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

/** One temp data dir per test: the report, the worktrees and the database all stay under it. */
function setup(): { db: Db; repo: Repo; root: string; worktreesDir: string; reportsDir: string; notices: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-nightly-'));
  roots.push(root);
  const reportsDir = path.join(root, 'reports');
  // Fail closed: the live data dir is never a test's landing spot, however the OS temp dir resolves.
  expect([root, reportsDir].some((p) => p.startsWith(path.join(os.homedir(), '.overseer')))).toBe(false);
  const db = openDb(':memory:', { batchIdSuffix: () => '' });
  const repo: Repo = { id: 'r1', path: path.join(root, 'checkout'), base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 2, model_filter: null };
  db.repos.insert(repo);
  return { db, repo, root, worktreesDir: path.join(root, 'worktrees'), reportsDir, notices: [] };
}

function addBatch(db: Db, id: string): void {
  db.batches.insert({ id, repo_id: 'r1', title: id, branch: `feature/${id}`, base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: `${DAY}T00:00:00.000Z`, updated_at: `${DAY}T00:00:00.000Z`, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
}

function addSignal(db: Db, kind: BatchSignalKind, beadId: string, text: string, ts: string, batchId = 'r1-b1'): void {
  const row = db.signals.insert({ batch_id: batchId, bead_id: beadId, kind, text });
  db.sql.prepare('UPDATE batch_signals SET ts=? WHERE id=?').run(ts, row.id);
}

/** A report with every counter at zero, so one test can set exactly the field its threshold reads. */
function quietReport(overrides: Partial<DayReport> = {}): DayReport {
  return {
    date: DAY, repo_id: 'r1',
    workers_no_commits: { total: 0, by_bead: [] },
    redispatches: { total: 0, by_bead: [], above_threshold: [] },
    review_rounds: { total: 0, by_bead: [], above_threshold: [] },
    landed_with_open_findings: { total: 0, beads: [] },
    closed_wont_do: { total: 0, beads: [] },
    cost: { reported: 0, unknown_sessions: 0, landed_beads: 0, per_landed_bead: null },
    deregistered_worktrees: { count: 0, bytes: 0, paths: [] },
    ...overrides,
  };
}

/** Yields the fake clock until `check` holds; the run's awaits are microtasks, but this cannot hang if one is a timer. */
async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error('the nightly run did not settle');
}

describe('nightly report thresholds', () => {
  it('notifies nothing for a quiet day', () => {
    expect(thresholdNotice(quietReport())).toBeNull();
  });

  it('trips on the third session that ended without commits, not the second', () => {
    const two = quietReport({ workers_no_commits: { total: 2, by_bead: [{ bead_id: 'ov-1', count: 1 }, { bead_id: 'ov-2', count: 1 }] } });
    expect(thresholdNotice(two)).toBeNull();
    const three = quietReport({ workers_no_commits: { total: 3, by_bead: [{ bead_id: 'ov-1', count: 1 }, { bead_id: 'ov-2', count: 1 }, { bead_id: 'ov-3', count: 1 }] } });
    expect(thresholdNotice(three)).toBe(`Day report for r1 on ${DAY}: ${NO_COMMIT_THRESHOLD} sessions ended without commits (ov-1 x1, ov-2 x1, ov-3 x1).`);
  });

  it('trips on a bead past its third re-dispatch, not on exactly three', () => {
    const three = quietReport({ redispatches: { total: 3, by_bead: [{ bead_id: 'ov-4', count: 3 }], above_threshold: [] } });
    expect(thresholdNotice(three)).toBeNull();
    const four = quietReport({ redispatches: { total: 4, by_bead: [{ bead_id: 'ov-4', count: 4 }], above_threshold: ['ov-4'] } });
    expect(thresholdNotice(four)).toBe(`Day report for r1 on ${DAY}: re-dispatched past ${REDISPATCH_THRESHOLD}: ov-4 x4.`);
  });

  it('trips on a bead past the review-round limit, naming only the beads above it', () => {
    const at = quietReport({ review_rounds: { total: 2, by_bead: [{ bead_id: 'ov-7', count: 2 }], above_threshold: [] } });
    expect(thresholdNotice(at)).toBeNull();
    const above = quietReport({ review_rounds: { total: 4, by_bead: [{ bead_id: 'ov-7', count: 3 }, { bead_id: 'ov-8', count: 1 }], above_threshold: ['ov-7'] } });
    expect(thresholdNotice(above)).toBe(`Day report for r1 on ${DAY}: review rounds past ${REVIEW_ROUND_THRESHOLD}: ov-7 x3.`);
  });

  it('trips only when the orphan worktree bytes exceed one gigabyte', () => {
    const at = quietReport({ deregistered_worktrees: { count: 2, bytes: ORPHAN_BYTES_THRESHOLD, paths: ['/a', '/b'] } });
    expect(thresholdNotice(at)).toBeNull();
    const over = quietReport({ deregistered_worktrees: { count: 2, bytes: ORPHAN_BYTES_THRESHOLD + 1, paths: ['/a', '/b'] } });
    expect(thresholdNotice(over)).toBe(`Day report for r1 on ${DAY}: orphan worktrees 1.00 GB in 2 dirs.`);
  });

  it('names every tripped threshold in one notice', () => {
    const r = quietReport({
      workers_no_commits: { total: 3, by_bead: [{ bead_id: 'ov-1', count: 1 }, { bead_id: 'ov-2', count: 1 }, { bead_id: 'ov-3', count: 1 }] },
      redispatches: { total: 4, by_bead: [{ bead_id: 'ov-4', count: 4 }], above_threshold: ['ov-4'] },
      review_rounds: { total: 3, by_bead: [{ bead_id: 'ov-7', count: 3 }], above_threshold: ['ov-7'] },
      deregistered_worktrees: { count: 1, bytes: ORPHAN_BYTES_THRESHOLD + 1, paths: ['/a'] },
    });
    const notice = thresholdNotice(r)!;
    expect(notice).toContain('3 sessions ended without commits');
    expect(notice).toContain('re-dispatched past 3: ov-4 x4');
    expect(notice).toContain('review rounds past 2: ov-7 x3');
    expect(notice).toContain('orphan worktrees 1.00 GB in 1 dir');
    expect(notice.endsWith('.')).toBe(true);
  });
});

describe('nightly run', () => {
  it('writes the day file for every repo and returns the notices the thresholds tripped', async () => {
    const x = setup();
    addBatch(x.db, 'r1-b1');
    for (const bead of ['ov-1', 'ov-2', 'ov-3']) addSignal(x.db, 'reopen', bead, 'no_commits: nothing to land', `${DAY}T09:00:00.000Z`);
    // 01:00 UTC the next day: the last complete UTC day is `DAY`.
    const out = await runNightlyReport({ db: x.db, worktreesDir: x.worktreesDir, reportsDir: x.reportsDir, notify: async (m) => { x.notices.push(m); }, now: () => Date.parse('2026-09-19T01:00:00.000Z') });
    expect(out.date).toBe(DAY);
    expect(out.path).toBe(path.join(x.reportsDir, `${DAY}.txt`));
    expect(fs.readFileSync(out.path, 'utf8')).toContain(`Day report for r1 on ${DAY}`);
    expect(x.notices).toEqual([`Day report for r1 on ${DAY}: 3 sessions ended without commits (ov-1 x1, ov-2 x1, ov-3 x1).`]);
  });
});

describe('nightly schedule', () => {
  it('runs once a night at the fixed local hour, over the day that just ended', async () => {
    vi.useFakeTimers();
    const x = setup();
    addBatch(x.db, 'r1-b1');
    vi.setSystemTime(new Date(2026, 8, 18, 2, 0, 0));
    const start = Date.now();
    const delay = msUntilNextLocalHour(start, 3);
    const fire = start + delay;
    const day = utcDayBefore(fire);
    for (const bead of ['ov-1', 'ov-2', 'ov-3']) addSignal(x.db, 'reopen', bead, 'no_commits: nothing to land', `${day}T09:00:00.000Z`);
    const stop = startNightlyReport({ db: x.db, worktreesDir: x.worktreesDir, reportsDir: x.reportsDir, notify: async (m) => { x.notices.push(m); }, hour: 3 });
    try {
      // Half past the hour before: nothing has run.
      await vi.advanceTimersByTimeAsync(Math.floor(delay / 2));
      expect(fs.existsSync(x.reportsDir)).toBe(false);
      expect(x.notices).toEqual([]);
      await vi.advanceTimersByTimeAsync(Math.ceil(delay / 2));
      await settle(() => fs.existsSync(path.join(x.reportsDir, `${day}.txt`)));
      expect(fs.readdirSync(x.reportsDir)).toEqual([`${day}.txt`]);
      expect(x.notices).toEqual([`Day report for r1 on ${day}: 3 sessions ended without commits (ov-1 x1, ov-2 x1, ov-3 x1).`]);
      // The next night reports the next day, so exactly one run happened per night.
      const delay2 = msUntilNextLocalHour(fire, 3);
      const day2 = utcDayBefore(fire + delay2);
      await vi.advanceTimersByTimeAsync(delay2);
      await settle(() => fs.existsSync(path.join(x.reportsDir, `${day2}.txt`)));
      expect(fs.readdirSync(x.reportsDir).sort()).toEqual([`${day}.txt`, `${day2}.txt`].sort());
    } finally { stop(); }
  });

  it('keeps a quiet night quiet, writing the file and notifying nothing', async () => {
    vi.useFakeTimers();
    const x = setup();
    addBatch(x.db, 'r1-b1');
    vi.setSystemTime(new Date(2026, 8, 18, 2, 0, 0));
    const delay = msUntilNextLocalHour(Date.now(), 3);
    const day = utcDayBefore(Date.now() + delay);
    const stop = startNightlyReport({ db: x.db, worktreesDir: x.worktreesDir, reportsDir: x.reportsDir, notify: async (m) => { x.notices.push(m); }, hour: 3 });
    try {
      await vi.advanceTimersByTimeAsync(delay);
      await settle(() => fs.existsSync(path.join(x.reportsDir, `${day}.txt`)));
      expect(fs.readFileSync(path.join(x.reportsDir, `${day}.txt`), 'utf8')).toContain('workers ending without commits: 0');
      expect(x.notices).toEqual([]);
    } finally { stop(); }
  });

  it('skips a night the daemon was down instead of replaying it the next morning', async () => {
    vi.useFakeTimers();
    const x = setup();
    vi.setSystemTime(new Date(2026, 8, 18, 9, 0, 0)); // the hour passed while the daemon was down
    const delay = msUntilNextLocalHour(Date.now(), 3);
    const day = utcDayBefore(Date.now() + delay);
    const stop = startNightlyReport({ db: x.db, worktreesDir: x.worktreesDir, reportsDir: x.reportsDir, notify: async (m) => { x.notices.push(m); }, hour: 3 });
    try {
      // Starting after the hour writes nothing: the missed night is not replayed.
      await vi.advanceTimersByTimeAsync(0);
      await settle(() => true);
      expect(fs.existsSync(x.reportsDir)).toBe(false);
      await vi.advanceTimersByTimeAsync(delay);
      await settle(() => fs.existsSync(path.join(x.reportsDir, `${day}.txt`)));
      // Only the next night ran, and only for the day it reports.
      expect(fs.readdirSync(x.reportsDir)).toEqual([`${day}.txt`]);
    } finally { stop(); }
  });

  it('logs a failed run and schedules the next night rather than breaking the daemon', async () => {
    vi.useFakeTimers();
    const x = setup();
    addBatch(x.db, 'r1-b1');
    vi.setSystemTime(new Date(2026, 8, 18, 2, 0, 0));
    const delay = msUntilNextLocalHour(Date.now(), 3);
    const day = utcDayBefore(Date.now() + delay);
    for (const bead of ['ov-1', 'ov-2', 'ov-3']) addSignal(x.db, 'reopen', bead, 'no_commits: nothing to land', `${day}T09:00:00.000Z`);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const stop = startNightlyReport({
      db: x.db, worktreesDir: x.worktreesDir, reportsDir: x.reportsDir, hour: 3,
      notify: async () => { throw new Error('the orchestrator is unreachable'); },
    });
    try {
      await vi.advanceTimersByTimeAsync(delay);
      await settle(() => errorSpy.mock.calls.some(([m]) => String(m).includes('nightly run failed')));
      // The file was written before the failing notice, and the next night still fires.
      expect(fs.existsSync(path.join(x.reportsDir, `${day}.txt`))).toBe(true);
      const delay2 = msUntilNextLocalHour(Date.now(), 3);
      const day2 = utcDayBefore(Date.now() + delay2);
      await vi.advanceTimersByTimeAsync(delay2);
      await settle(() => fs.existsSync(path.join(x.reportsDir, `${day2}.txt`)));
      expect(fs.readdirSync(x.reportsDir).sort()).toEqual([`${day}.txt`, `${day2}.txt`].sort());
    } finally { stop(); errorSpy.mockRestore(); }
  });
});
