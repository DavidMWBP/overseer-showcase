import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db';
import { log } from '../util/log';
import { msUntilNextLocalHour, NIGHTLY_HOUR } from './nightly';

/**
 * The nightly retention job: after the configured window a session's events and its stdio log are deleted, while its session
 * row, cost and token counts stay (Usage and the retrospectives read them). A running session is never touched. The events
 * table is the bulk of the database — a `tool_result` alone is over 90% of its payload bytes — so once the rows are gone an
 * incremental vacuum returns the freed pages to the filesystem. A database not created with `auto_vacuum=INCREMENTAL` needs
 * one full VACUUM to change the mode, so that is done here once, inside the job, with its duration logged.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  db: Db;
  /** One stdio log per session lives here; deletion stays inside it. A row with no `log_path`, or one pointing outside, falls back to `<sessionsDir>/<id>.log`. */
  sessionsDir: string;
  /** Days after a session ended before its events and log go; its row stays. */
  retentionDays: number;
  now?: () => number;
}

export interface RetentionRun {
  /** ISO timestamp; a session whose `ended_at` is strictly before it is eligible. */
  cutoff: string;
  sessions: number;
  events: number;
  logs: number;
  /** True when this run had to change auto_vacuum to INCREMENTAL, which is the run that pays the one-off VACUUM. */
  switchedAutoVacuum: boolean;
  /** How long the one-off VACUUM took in milliseconds; 0 when auto_vacuum was already INCREMENTAL. */
  vacuumMs: number;
}

/** Whether `p` resolves to a path inside `dir` (not `dir` itself, not a parent, not another drive). */
function inside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * The log base path to delete for one session. A stored `log_path` is used only when it resolves inside the sessions dir;
 * an old or altered row can point anywhere, and deletion stays scoped to that dir. A row with no path, or one outside it,
 * falls back to the conventional `<sessionsDir>/<id>.log` so the session's own log is still reclaimed.
 */
function logPathFor(sessionsDir: string, session: { id: string; log_path: string | null }): string {
  const stored = session.log_path;
  return stored && inside(sessionsDir, stored) ? stored : path.join(sessionsDir, `${session.id}.log`);
}

/** Deletes the log file and its `.err`/`.pid` siblings; a file that is already gone is skipped. Returns how many went. */
function removeLogFiles(logPath: string): number {
  let removed = 0;
  for (const p of [logPath, `${logPath}.err`, `${logPath}.pid`]) {
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { force: true }); removed++; } catch (err) { log.warn(`retention: could not delete ${p}`, err); }
  }
  return removed;
}

/** Frees the pages the deletes left behind. Switching an existing database to INCREMENTAL is the only step that needs a full VACUUM. */
function vacuum(db: Db): { switchedAutoVacuum: boolean; vacuumMs: number } {
  const mode = (db.sql.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
  const switchedAutoVacuum = mode !== 2;
  let vacuumMs = 0;
  if (switchedAutoVacuum) {
    const started = Date.now();
    db.sql.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.sql.exec('VACUUM');
    vacuumMs = Date.now() - started;
    log.info(`retention: auto_vacuum was not INCREMENTAL, switched it and ran the one-off VACUUM in ${vacuumMs} ms`);
  }
  db.sql.exec('PRAGMA incremental_vacuum');
  return { switchedAutoVacuum, vacuumMs };
}

/** One pass: delete the events and logs of every session that ended before the window, then vacuum. Any throw propagates to the caller. */
export function runRetention(deps: RetentionDeps): RetentionRun {
  const now = deps.now?.() ?? Date.now();
  const cutoff = new Date(now - deps.retentionDays * DAY_MS).toISOString();
  let sessions = 0;
  let events = 0;
  let logs = 0;
  for (const s of deps.db.sessions.all()) {
    // A running session keeps both its events and its log, however long it has run; ended_at is what marks an ended row.
    if (s.status === 'running' || !s.ended_at || s.ended_at >= cutoff) continue;
    sessions++;
    events += deps.db.events.deleteForSession(s.id);
    logs += removeLogFiles(logPathFor(deps.sessionsDir, s));
  }
  const { switchedAutoVacuum, vacuumMs } = vacuum(deps.db);
  log.debug(`retention: deleted ${events} events and ${logs} log files for ${sessions} session(s) ended before ${cutoff}`);
  return { cutoff, sessions, events, logs, switchedAutoVacuum, vacuumMs };
}

/**
 * Schedules the pass for the next local `hour` and then keeps scheduling it forward, the same shape as the nightly report.
 * Returns the stop function.
 */
export function startRetention(deps: RetentionDeps & { hour?: number }): () => void {
  const hour = deps.hour ?? NIGHTLY_HOUR;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      try { runRetention(deps); } catch (err) { log.error('retention: the nightly run failed', err); }
      if (!stopped) schedule();
    }, msUntilNextLocalHour(deps.now?.() ?? Date.now(), hour));
    timer.unref?.(); // the retention job must never be the reason the process stays alive
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
