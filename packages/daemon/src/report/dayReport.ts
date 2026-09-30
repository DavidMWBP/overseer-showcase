import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import type { Db } from '../db/db';
import { buildRetrospective } from '../lifecycle/retrospective';
import { git } from '../git/git';

/**
 * The counters in this module read the record the daemon already stores and nothing else: the batch signals the lifecycle writes
 * (`batch_signals`, through the retrospective reader so there is one extraction of reopens, re-dispatches and closes), the
 * sessions the usage reader sums for a repo and day, the worktree rows, and the worktree folders on disk. It computes; a
 * sibling owns the schedule, the notice and the UI.
 */

/** Above this many re-dispatches on one bead the report names it. */
export const REDISPATCH_THRESHOLD = 3;
/** Above this many review rounds on one bead the report names it. */
export const REVIEW_ROUND_THRESHOLD = 2;

/**
 * The one reopen reason that proves the branch had nothing to land when the worker ended: `no_commits` (a crash included). The
 * other reasons that can follow a session do not prove it: `uncommitted_changes` is only written when the branch already has
 * work to land, and `stopped` covers both a Board stop and a usage-limit stop without saying whether the worker committed.
 */
const NO_COMMIT_REASON = 'no_commits';

/** One bead and how many times a signal of one kind named it that day. */
export interface BeadCount {
  bead_id: string;
  count: number;
}

export interface DayReport {
  /** The UTC calendar day, `YYYY-MM-DD`, as `started_at` and signal timestamps are written. */
  date: string;
  repo_id: string;
  /** Worker sessions whose bead was reopened after they ended without a commit, grouped by bead. */
  workers_no_commits: { total: number; by_bead: BeadCount[] };
  redispatches: { total: number; by_bead: BeadCount[]; above_threshold: string[] };
  /** A review round is one critic session started that day; a crash-recovered round that re-runs a critic is one extra session. */
  review_rounds: { total: number; by_bead: BeadCount[]; above_threshold: string[] };
  landed_with_open_findings: { total: number; beads: string[] };
  closed_wont_do: { total: number; beads: string[] };
  cost: {
    /** The CLI-reported cost of every session of the repo started that day; a floor while `unknown_sessions` is above zero. */
    reported: number;
    /** Sessions of the day that reported no cost (a CLI that reports none, or one that ended before its result line). */
    unknown_sessions: number;
    landed_beads: number;
    /** `reported` divided by the beads landed that day; null when none landed. */
    per_landed_bead: number | null;
  };
  /** Worktree folders under the configured worktrees directory that git no longer lists for the repo (the deregistered pile). */
  deregistered_worktrees: { count: number; bytes: number; paths: string[] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The half-open UTC bounds of a `YYYY-MM-DD` day, in the ISO shape `started_at` uses. */
export function dayBounds(date: string): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid day: ${date}`);
  return { from: new Date(start).toISOString(), to: new Date(start + DAY_MS).toISOString() };
}

/** Counts the entries per bead, highest count first, ties by bead id. */
function countByBead(beads: string[]): BeadCount[] {
  const counts = new Map<string, number>();
  for (const bead of beads) counts.set(bead, (counts.get(bead) ?? 0) + 1);
  return [...counts.entries()]
    .map(([bead_id, count]) => ({ bead_id, count }))
    .sort((a, b) => b.count - a.count || a.bead_id.localeCompare(b.bead_id));
}

/** A path as git and the filesystem may spell it differently (case, separators): resolve, and fold case on Windows. */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Every file's size below `dir`, recursively. A path that vanishes mid-scan (a live worktree) contributes nothing. */
export function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(child);
      else if (entry.isFile()) total += fs.statSync(child).size;
    } catch {
      // A file removed between the readdir and the stat: it has no size to count.
    }
  }
  return total;
}

/**
 * The immediate subdirectories of `<worktreesDir>/<repo id>` that `git worktree list` does not name: a worktree git pruned (or
 * never registered) while its folder stayed behind. Returns them sorted, with their total on-disk size.
 */
export async function deregisteredWorktrees(repo: Repo, worktreesDir: string): Promise<{ count: number; bytes: number; paths: string[] }> {
  const repoDir = path.join(worktreesDir, repo.id);
  if (!fs.existsSync(repoDir)) return { count: 0, bytes: 0, paths: [] };
  const listed = new Set(
    (await git(repo.path, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => normalizePath(line.slice('worktree '.length))),
  );
  const paths: string[] = [];
  let bytes = 0;
  for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(repoDir, entry.name);
    if (listed.has(normalizePath(dir))) continue;
    paths.push(dir);
    bytes += dirBytes(dir);
  }
  paths.sort();
  return { count: paths.length, bytes, paths };
}

/** Builds the report for one UTC day and one repo from the stored record and the worktrees directory it manages. */
export async function buildDayReport(db: Db, repo: Repo, date: string, worktreesDir: string): Promise<DayReport> {
  const { from, to } = dayBounds(date);
  const inDay = (ts: string) => ts >= from && ts < to;

  const noCommitBeads: string[] = [];
  const redispatchBeads: string[] = [];
  const closedBeads: string[] = [];
  for (const batch of db.batches.forRepo(repo.id)) {
    // Reuse the retrospective's one signal extraction; only its counts are wanted here, so no bd list is read.
    const r = buildRetrospective(db, batch, null);
    for (const s of r.signals.reopens) if (inDay(s.ts) && s.reason === NO_COMMIT_REASON) noCommitBeads.push(s.bead_id);
    for (const s of r.signals.redispatches) if (inDay(s.ts)) redispatchBeads.push(s.bead_id);
    for (const s of r.signals.closed) if (inDay(s.ts)) closedBeads.push(s.bead_id);
  }

  const worktrees = db.worktrees.forRepo(repo.id);
  const reviewBeads = worktrees.flatMap((wt) =>
    db.sessions.forBead(wt.bead_id)
      .filter((s) => s.role === 'critic' && s.started_at >= from && s.started_at < to)
      .map(() => wt.bead_id));

  const landed = worktrees.filter((wt) => wt.merged_at !== null && inDay(wt.merged_at));
  const withFindings = landed
    .filter((wt) => wt.accepted_note !== null || (wt.review_findings?.length ?? 0) > 0)
    .map((wt) => wt.bead_id)
    .sort();

  // The usage reader is the one place a repo's sessions for a UTC day are summed; the CLI-reported figure is the day's cost.
  const spend = db.usage.by('repo', from, to).find((row) => row.key === repo.id);
  const reported = spend?.reported_cost ?? 0;
  const landedCount = landed.length;

  const redispatches = countByBead(redispatchBeads);
  const reviewRounds = countByBead(reviewBeads);
  const closed = [...new Set(closedBeads)].sort();
  const deregistered = await deregisteredWorktrees(repo, worktreesDir);

  return {
    date,
    repo_id: repo.id,
    workers_no_commits: { total: noCommitBeads.length, by_bead: countByBead(noCommitBeads) },
    redispatches: {
      total: redispatches.reduce((sum, b) => sum + b.count, 0),
      by_bead: redispatches,
      above_threshold: redispatches.filter((b) => b.count > REDISPATCH_THRESHOLD).map((b) => b.bead_id),
    },
    review_rounds: {
      total: reviewRounds.reduce((sum, b) => sum + b.count, 0),
      by_bead: reviewRounds,
      above_threshold: reviewRounds.filter((b) => b.count > REVIEW_ROUND_THRESHOLD).map((b) => b.bead_id),
    },
    landed_with_open_findings: { total: withFindings.length, beads: withFindings },
    closed_wont_do: { total: closed.length, beads: closed },
    cost: {
      reported,
      unknown_sessions: spend?.reported_unknown ?? 0,
      landed_beads: landedCount,
      per_landed_bead: landedCount ? reported / landedCount : null,
    },
    deregistered_worktrees: deregistered,
  };
}

/** `n beads (id x2, id x1)`, or `n beads` when no bead is named. */
function beadsLine(total: number, byBead: BeadCount[]): string {
  const named = byBead.map((b) => `${b.bead_id} x${b.count}`).join(', ');
  return `${total}${named ? ` (${named})` : ''}`;
}

/** `2.70 GB`; bytes below 1 KiB stay in bytes so an empty directory set reads `0 B`, not `0.00 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(2)} ${units[unit]}`;
}

/** The report as plain text, one line per counter, for a log line or a notice body. */
export function renderDayReport(r: DayReport): string {
  const named = (ids: string[]) => (ids.length ? ` (${ids.join(', ')})` : '');
  const per = r.cost.per_landed_bead === null ? 'n/a' : `$${r.cost.per_landed_bead.toFixed(2)}`;
  return [
    `Day report for ${r.repo_id} on ${r.date}`,
    `workers ending without commits: ${beadsLine(r.workers_no_commits.total, r.workers_no_commits.by_bead)}`,
    `re-dispatches: ${beadsLine(r.redispatches.total, r.redispatches.by_bead)}; above ${REDISPATCH_THRESHOLD}${named(r.redispatches.above_threshold)}`,
    `review rounds: ${beadsLine(r.review_rounds.total, r.review_rounds.by_bead)}; above ${REVIEW_ROUND_THRESHOLD}${named(r.review_rounds.above_threshold)}`,
    `landed with open findings: ${r.landed_with_open_findings.total}${named(r.landed_with_open_findings.beads)}`,
    `closed as won't do: ${r.closed_wont_do.total}${named(r.closed_wont_do.beads)}`,
    `cost: reported $${r.cost.reported.toFixed(2)} (${r.cost.unknown_sessions} ${r.cost.unknown_sessions === 1 ? 'session' : 'sessions'} without one); ${r.cost.landed_beads} ${r.cost.landed_beads === 1 ? 'bead' : 'beads'} landed, ${per} per landed bead`,
    `deregistered worktrees: ${r.deregistered_worktrees.count} ${r.deregistered_worktrees.count === 1 ? 'dir' : 'dirs'}, ${formatBytes(r.deregistered_worktrees.bytes)}${named(r.deregistered_worktrees.paths)}`,
  ].join('\n');
}
