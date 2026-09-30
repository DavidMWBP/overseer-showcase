import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db';
import { log } from '../util/log';
import { buildDayReport, formatBytes, REDISPATCH_THRESHOLD, REVIEW_ROUND_THRESHOLD, renderDayReport, type BeadCount, type DayReport } from './dayReport';

/**
 * The nightly count: once a night at a fixed local hour the daemon renders the day that just ended for every repo and stays
 * silent unless a threshold trips. A night the daemon was down is skipped, never replayed, because the schedule only ever
 * moves forward to the next hour. A failure is logged and never breaks the daemon.
 */

/** The fixed local hour the count runs at every night; the day it reports is the last complete UTC day at that moment. */
export const NIGHTLY_HOUR = 3;

/** Three or more worker sessions that ended without a commit in the day is worth a notice. */
export const NO_COMMIT_THRESHOLD = 3;

/** Orphan worktree directories past this many bytes for one repository are worth a notice. */
export const ORPHAN_BYTES_THRESHOLD = 1024 ** 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day that just ended at `now`, `YYYY-MM-DD`, as `started_at` and the report's counters are written. */
export function utcDayBefore(now: number): string {
  return new Date(now - DAY_MS).toISOString().slice(0, 10);
}

/** Milliseconds from `now` to the next local `hour:00:00`, tomorrow when today's hour has already passed. */
export function msUntilNextLocalHour(now: number, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now) {
    next.setDate(next.getDate() + 1);
    next.setHours(hour, 0, 0, 0);
  }
  return next.getTime() - now;
}

/** The beads above one threshold as `id x2, id x1`, in the report's order. */
function namedCounts(byBead: BeadCount[], ids: string[]): string {
  return byBead.filter((b) => ids.includes(b.bead_id)).map((b) => `${b.bead_id} x${b.count}`).join(', ');
}

/**
 * One line naming the numbers and the beads that tripped a threshold, or null for a quiet day. It says nothing else: no advice
 * and no hint for the orchestrator.
 */
export function thresholdNotice(r: DayReport): string | null {
  const parts: string[] = [];
  if (r.workers_no_commits.total >= NO_COMMIT_THRESHOLD) {
    const beads = r.workers_no_commits.by_bead.map((b) => `${b.bead_id} x${b.count}`).join(', ');
    parts.push(`${r.workers_no_commits.total} sessions ended without commits (${beads})`);
  }
  if (r.redispatches.above_threshold.length) {
    parts.push(`re-dispatched past ${REDISPATCH_THRESHOLD}: ${namedCounts(r.redispatches.by_bead, r.redispatches.above_threshold)}`);
  }
  if (r.review_rounds.above_threshold.length) {
    parts.push(`review rounds past ${REVIEW_ROUND_THRESHOLD}: ${namedCounts(r.review_rounds.by_bead, r.review_rounds.above_threshold)}`);
  }
  if (r.deregistered_worktrees.bytes > ORPHAN_BYTES_THRESHOLD) {
    const d = r.deregistered_worktrees;
    parts.push(`orphan worktrees ${formatBytes(d.bytes)} in ${d.count} ${d.count === 1 ? 'dir' : 'dirs'}`);
  }
  return parts.length ? `Day report for ${r.repo_id} on ${r.date}: ${parts.join('; ')}.` : null;
}

export interface NightlyDeps {
  db: Db;
  worktreesDir: string;
  /** Where the per-day plain-text files are written; one file per day, so a run can be read back. */
  reportsDir: string;
  /** The daemon's existing notify path to the orchestrator; reused, never a second one. */
  notify: (text: string) => Promise<void>;
  now?: () => number;
}

export interface NightlyRun {
  date: string;
  path: string;
  notices: string[];
}

/** Builds the report for every repo, writes the day's file, and notifies only the repos that tripped a threshold. */
export async function runNightlyReport(deps: NightlyDeps): Promise<NightlyRun> {
  const date = utcDayBefore(deps.now?.() ?? Date.now());
  const reports: DayReport[] = [];
  for (const repo of deps.db.repos.all()) reports.push(await buildDayReport(deps.db, repo, date, deps.worktreesDir));
  const file = path.join(deps.reportsDir, `${date}.txt`);
  fs.mkdirSync(deps.reportsDir, { recursive: true });
  fs.writeFileSync(file, reports.map(renderDayReport).join('\n\n'));
  const notices = reports.map(thresholdNotice).filter((n): n is string => n !== null);
  for (const notice of notices) await deps.notify(notice);
  return { date, path: file, notices };
}

/**
 * Schedules the run for the next local `hour` and then keeps scheduling it forward. Nothing runs at startup, so a night the
 * daemon was down is skipped rather than replayed the next morning. Returns the stop function.
 */
export function startNightlyReport(deps: NightlyDeps & { hour?: number }): () => void {
  const hour = deps.hour ?? NIGHTLY_HOUR;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runNightlyReport(deps)
        .catch((err) => log.error('report: the nightly run failed', err))
        .finally(() => { if (!stopped) schedule(); });
    }, msUntilNextLocalHour(deps.now?.() ?? Date.now(), hour));
    timer.unref?.(); // the nightly job must never be the reason the process stays alive
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
