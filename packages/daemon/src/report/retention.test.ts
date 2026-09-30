import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../db/db';
import type { SessionStatus } from '@overseer/shared';
import { msUntilNextLocalHour } from './nightly';
import { runRetention, startRetention } from './retention';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

const NOW = Date.parse('2026-09-18T03:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY_MS).toISOString();

/** One temp data dir per test: the database and the session logs both stay under it. */
function setup(): { db: Db; root: string; sessionsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-retention-'));
  roots.push(root);
  // Fail closed: the live data dir is never a test's landing spot, however the OS temp dir resolves.
  expect(root.startsWith(path.join(os.homedir(), '.overseer'))).toBe(false);
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { db: openDb(path.join(root, 'overseer.db'), { batchIdSuffix: () => '' }), root, sessionsDir };
}

let seq = 0;
function addSession(db: Db, status: SessionStatus, endedAt: string | null): string {
  const id = `s${++seq}`;
  db.sessions.insert({ id, harness: 'claude', role: 'worker', bead_id: 'b1', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/wt', status, started_at: '2026-01-01T00:00:00.000Z', ended_at: endedAt, cost: 1.5, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, input_tokens: 10, output_tokens: 20 });
  db.events.append(id, 'assistant_text', { text: id });
  return id;
}

/** Writes the three files a session log leaves behind: the log, its stderr sibling and its pid file. */
function writeLogs(sessionsDir: string, id: string): string {
  const logPath = path.join(sessionsDir, `${id}.log`);
  for (const p of [logPath, `${logPath}.err`, `${logPath}.pid`]) fs.writeFileSync(p, id);
  return logPath;
}

describe('runRetention', () => {
  it('deletes only ended-and-old sessions\' events and logs, keeping rows and skipping a running session', () => {
    const { db, sessionsDir } = setup();
    try {
      const old = addSession(db, 'ended', daysAgo(20));
      const recent = addSession(db, 'ended', daysAgo(1));
      const running = addSession(db, 'running', null);
      const boundary = addSession(db, 'ended', daysAgo(14)); // exactly at the window: "more than 14 days" is strict
      for (const id of [old, recent, running, boundary]) db.sessions.update(id, { log_path: writeLogs(sessionsDir, id) });

      const out = runRetention({ db, sessionsDir, retentionDays: 14, now: () => NOW });

      expect(out).toMatchObject({ sessions: 1, events: 1, logs: 3, switchedAutoVacuum: true });
      expect(db.events.forSession(old)).toHaveLength(0);
      expect(db.events.forSession(recent)).toHaveLength(1);
      expect(db.events.forSession(running)).toHaveLength(1);
      expect(db.events.forSession(boundary)).toHaveLength(1);
      expect(fs.existsSync(path.join(sessionsDir, `${old}.log`))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, `${old}.log.err`))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, `${old}.log.pid`))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, `${recent}.log`))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, `${running}.log`))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, `${boundary}.log`))).toBe(true);
      // Rows, cost and token counts stay: Usage and the retrospective read them.
      expect(db.sessions.get(old)).toMatchObject({ status: 'ended', cost: 1.5, input_tokens: 10, output_tokens: 20 });
      expect(db.sessions.all()).toHaveLength(4);
    } finally { db.sql.close(); }
  });

  it('deletes a log at <sessions dir>/<id>.log when the row carries no log path', () => {
    const { db, sessionsDir } = setup();
    try {
      const old = addSession(db, 'ended', daysAgo(30));
      fs.writeFileSync(path.join(sessionsDir, `${old}.log`), 'x');

      const out = runRetention({ db, sessionsDir, retentionDays: 14, now: () => NOW });

      expect(out.logs).toBe(1);
      expect(fs.existsSync(path.join(sessionsDir, `${old}.log`))).toBe(false);
    } finally { db.sql.close(); }
  });

  it('never deletes a log path outside the sessions directory, even for an eligible session', () => {
    const { db, root, sessionsDir } = setup();
    try {
      const old = addSession(db, 'ended', daysAgo(20));
      // An old or altered row can carry a path anywhere; only the sessions dir is in scope for deletion.
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsidePath = path.join(outsideDir, 'elsewhere.log');
      for (const p of [outsidePath, `${outsidePath}.err`, `${outsidePath}.pid`]) fs.writeFileSync(p, 'keep');
      db.sessions.update(old, { log_path: outsidePath });
      fs.writeFileSync(path.join(sessionsDir, `${old}.log`), 'move');

      const out = runRetention({ db, sessionsDir, retentionDays: 14, now: () => NOW });

      expect(db.events.forSession(old)).toHaveLength(0);
      for (const p of [outsidePath, `${outsidePath}.err`, `${outsidePath}.pid`]) expect(fs.existsSync(p)).toBe(true);
      // The session's own log under the sessions dir is still retention's to delete.
      expect(fs.existsSync(path.join(sessionsDir, `${old}.log`))).toBe(false);
      expect(out.logs).toBe(1);
    } finally { db.sql.close(); }
  });

  it('switches auto_vacuum to INCREMENTAL with a one-off VACUUM only the first time', () => {
    const { db, sessionsDir } = setup();
    try {
      const first = runRetention({ db, sessionsDir, retentionDays: 14, now: () => NOW });
      expect(first.switchedAutoVacuum).toBe(true);
      expect(first.vacuumMs).toBeGreaterThanOrEqual(0);
      expect(db.sql.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });

      const second = runRetention({ db, sessionsDir, retentionDays: 14, now: () => NOW });
      expect(second.switchedAutoVacuum).toBe(false);
      expect(second.vacuumMs).toBe(0);
    } finally { db.sql.close(); }
  });

  it('is quiet on a database with nothing to delete', () => {
    const { db, sessionsDir } = setup();
    try {
      const recent = addSession(db, 'ended', daysAgo(1));
      const out = runRetention({ db, sessionsDir, retentionDays: 14, now: () => NOW });
      expect(out).toMatchObject({ sessions: 0, events: 0, logs: 0 });
      expect(db.events.forSession(recent)).toHaveLength(1);
    } finally { db.sql.close(); }
  });
});

describe('startRetention', () => {
  it('runs once a night at the fixed local hour and stops on request', async () => {
    vi.useFakeTimers();
    const { db, sessionsDir } = setup();
    try {
      vi.setSystemTime(new Date(2026, 8, 18, 2, 0, 0));
      const delay = msUntilNextLocalHour(Date.now(), 3);
      const old = addSession(db, 'ended', new Date(Date.now() + delay - 20 * 24 * 60 * 60 * 1000).toISOString());
      db.sessions.update(old, { log_path: writeLogs(sessionsDir, old) });
      const stop = startRetention({ db, sessionsDir, retentionDays: 14, hour: 3 });
      try {
        await vi.advanceTimersByTimeAsync(Math.floor(delay / 2));
        expect(db.events.forSession(old)).toHaveLength(1); // nothing has run
        await vi.advanceTimersByTimeAsync(Math.ceil(delay / 2));
        await vi.advanceTimersByTimeAsync(0);
        expect(db.events.forSession(old)).toHaveLength(0);
      } finally { stop(); }
    } finally { db.sql.close(); }
  });
});
