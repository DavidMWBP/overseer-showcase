import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/db';
import type { SessionRow } from '@overseer/shared';
import { log } from '../util/log';
import { runCapture } from '../util/procs';
import { TURN_SILENCE_MS } from '../harness/opencode';

/** How often a running session is checked; the threshold itself is minutes, so a finer sweep would buy nothing. */
export const SWEEP_MS = 60_000;

export interface StallDeps {
  db: Db;
  /** Milliseconds of silence before a session counts as stalled; 0 disables the sweep. */
  stallMs: number;
  notify: (text: string, opts?: { wake?: boolean; hint?: string }) => Promise<void>;
  /** The sessions currently stalled, one call per pass, empty included, so the office feed can mark and clear them. */
  onStalled?: (ids: string[]) => void;
}

/** Session id → the last-event timestamp its stall was reported at, so one silent stretch is reported once. */
export type SeenStalls = Map<string, string>;

/** A worktree is read at most this often per session; git status on a large tree is not free. */
export const WORKTREE_CHECK_MS = 5 * 60_000;

/** Session id → when its worktree was last read and the newest change time found then (null when unreadable or clean). */
export type WorktreeChecks = Map<string, { at: number; mtime: number | null }>;

/**
 * The newest modification time among the worktree's changed files (`git status --porcelain`, so ignored paths such as
 * node_modules and dist never count), or null when the tree is clean, is not a git checkout or cannot be read.
 */
async function worktreeMtime(cwd: string): Promise<number | null> {
  const r = await runCapture('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd });
  if (r.code !== 0) return null;
  const files: string[] = [];
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    files.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // a rename carries its source path as the next entry
  }
  let newest: number | null = null;
  for (const f of files) {
    const st = await fs.stat(path.join(cwd, f)).catch(() => null); // a deleted file has no mtime
    if (st && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
  }
  return newest;
}

async function checkedMtime(s: SessionRow, checks: WorktreeChecks, now: number): Promise<number | null> {
  const cached = checks.get(s.id);
  if (cached && now - cached.at < WORKTREE_CHECK_MS) return cached.mtime;
  const mtime = s.cwd ? await worktreeMtime(s.cwd).catch(() => null) : null;
  checks.set(s.id, { at: now, mtime });
  return mtime;
}

const HINT = 'Call worker_status for the bead. If it is genuinely stuck, interrupt_worker with the reason; if it is waiting on something slow, leave it. Do not re-dispatch without asking the user.';

/** The stall threshold (15 minutes by default) comes before opencode's own silence limit, so its notice says the turn will end anyway. */
const OPENCODE_HINT = `${HINT} The opencode adapter ends a turn that prints nothing for ${TURN_SILENCE_MS / 60_000} minutes after its last event and after every running tool call's own timeout by itself, so a silent opencode session can be left until then rather than interrupted.`;

/** How a notice names the session that stalled: "worker (codex gpt-5.6-terra)". */
const nameOf = (s: SessionRow) => `${s.role} (${[s.harness, s.model].filter(Boolean).join(' ')})`;

/**
 * One pass: every running worker and critic whose log and worktree have both been quiet past the threshold gets a queued
 * notice, once per silent stretch. The worktree counts because an opencode sub-agent's edits can outpace what its log
 * shows; it is read only once the log is quiet, and at most every WORKTREE_CHECK_MS. The orchestrator is never swept — it is idle between the user's messages by design. The daemon only
 * reports; what to do about a stalled session is the orchestrator's decision, which is why the notice carries a hint.
 *
 * The same pass hands the office feed the ids of every session currently stalled, the quiet ones that were already reported
 * included: `onStalled` is called with the whole set (empty included), so a later pass that finds a session awake clears
 * its office mark, and repeated passes over the same silence publish nothing.
 */
export async function sweepStalls(deps: StallDeps, seen: SeenStalls, checks: WorktreeChecks = new Map()): Promise<void> {
  const { db, stallMs, notify } = deps;
  const now = Date.now();
  const running = db.sessions.running().filter((s) => s.role === 'worker' || s.role === 'critic');
  // A session that ended keeps no entry: its next run starts the detection afresh.
  for (const id of [...seen.keys()]) if (!running.some((s) => s.id === id)) seen.delete(id);
  for (const id of [...checks.keys()]) if (!running.some((s) => s.id === id)) checks.delete(id);

  const stalled: string[] = [];
  for (const s of running) {
    // No events yet means the session has said nothing since it started, so its start is its last sign of life.
    const lastTs = db.events.lastTs(s.id) ?? s.started_at;
    const idleMs = now - Date.parse(lastTs);
    if (idleMs < stallMs) continue;
    const mtime = await checkedMtime(s, checks, now);
    if (mtime !== null && now - mtime < stallMs) continue;
    stalled.push(s.id);
    const mark = mtime !== null && mtime > Date.parse(lastTs) ? `${lastTs}|${mtime}` : lastTs;
    if (seen.get(s.id) === mark) continue;
    seen.set(s.id, mark);
    const text = (db.events.lastOfType(s.id, 'assistant_text')?.payload as { text?: string } | undefined)?.text;
    const said = text ? ` last said: "${text}"` : ' has said nothing since it started';
    const minutes = Math.round(idleMs / 60_000);
    const tree = mtime === null ? ''
      : mtime > Date.parse(lastTs) ? `; quiet log for ${minutes} minutes, but the worktree changed ${Math.round((now - mtime) / 60_000)} minutes ago; a sub-agent may be working`
      : `; its worktree has not changed for ${Math.round((now - mtime) / 60_000)} minutes`;
    const what = `${s.bead_id ?? s.id} has shown no sign of activity for ${minutes} minutes; its ${nameOf(s)}${said}${tree}`;
    await notify(what, { hint: s.harness === 'opencode' ? OPENCODE_HINT : HINT }).catch((err) => log.error('stall: notify failed', err));
  }
  deps.onStalled?.(stalled);
}

/** Starts the sweep; returns the stop function, or null when the threshold is 0 and nothing runs. */
export function startStallSweep(deps: StallDeps): (() => void) | null {
  if (deps.stallMs <= 0) return null;
  const seen: SeenStalls = new Map();
  const checks: WorktreeChecks = new Map();
  const timer = setInterval(() => { void sweepStalls(deps, seen, checks).catch((err) => log.error('stall: sweep failed', err)); }, SWEEP_MS);
  timer.unref(); // the sweep must never be the reason the process stays alive
  return () => clearInterval(timer);
}
