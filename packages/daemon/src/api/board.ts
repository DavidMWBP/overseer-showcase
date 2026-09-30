import type { BatchSummary, Bead, BoardCard, BoardResponse, CardState, HarnessName, Repo, SessionRow } from '@overseer/shared';
import type { Db } from '../db/db';
import { BATCH_PREFIX, batchOf, columnFor, HARNESS_PREFIX, phaseOf, type TaskStore } from '../beads/store';
import { NO_VERIFY_RUN } from '../lifecycle/verify';
import { log } from '../util/log';
import type { ActionJobs } from './jobs';

const HARNESSES: HarnessName[] = ['claude', 'codex', 'opencode'];

/** A repo build past this is slow; the board's `bd list` (about half a second) plus its wait behind queued writes is the cost. */
const SLOW_BUILD_MS = 1000;
/** A slow repo logs at most once in this window; the builds in between are counted and reported with the next line. */
const SLOW_WARN_WINDOW_MS = 60_000;

/**
 * The `board build slow` line, at most once a minute per repo. The daemon.log was 84% this warning on 2026-09-23, so the
 * ones a minute hides are folded into the next line as `suppressed` instead of logged.
 */
export class SlowBuildWarner {
  private state = new Map<string, { at: number; suppressed: number }>();
  constructor(private now: () => number = Date.now, private warn: (msg: string, data: Record<string, unknown>) => void = (msg, data) => log.warn(msg, data)) {}
  note(repoId: string, ms: number): void {
    if (ms <= SLOW_BUILD_MS) return;
    const s = this.state.get(repoId);
    const t = this.now();
    if (!s || t - s.at >= SLOW_WARN_WINDOW_MS) {
      this.warn('board build slow', { repo: repoId, ms, suppressed: s?.suppressed ?? 0 });
      this.state.set(repoId, { at: t, suppressed: 0 });
    } else s.suppressed++;
  }
  /** For tests that share the module-level warner. */
  reset(): void { this.state.clear(); }
}
export const slowBuildWarnings = new SlowBuildWarner();

export async function buildBoard(db: Db, store: TaskStore, jobs?: ActionJobs): Promise<BoardResponse> {
  const bd_ok = await store.available();
  const timing: Record<string, number> = {};
  const repos = await Promise.all(db.repos.all().map(async (repo) => {
    const t1 = Date.now();
    const beads = bd_ok ? await store.list(repo.path) : [];
    const cards = bd_ok ? await cardsFor(db, store, repo, beads, jobs) : [];
    timing[repo.id] = Date.now() - t1; // almost entirely bd: one `list` (about half a second) plus its wait behind queued writes
    // A running action rides on the row so a reload still shows it, gone once the job ends.
    return { repo, batches: batchSummaries(db, repo.id, beads).map((b) => ({ ...b, pending_action: jobs?.pending('batch', b.id) ?? null })), cards };
  }));
  for (const [repoId, ms] of Object.entries(timing)) slowBuildWarnings.note(repoId, ms);
  return { bd_ok, repos };
}

/**
 * What a set of sessions cost, with the ones that ended without reporting a cost counted apart: a worker stopped or crashed
 * mid-turn never sends the harness's final event, the only place Claude Code states a cost, so the sum is a floor (round 14).
 */
export function costOf(rows: SessionRow[]): { total: number; unknown: number } {
  return { total: rows.reduce((a, s) => a + (s.cost ?? 0), 0), unknown: rows.filter((s) => s.status !== 'running' && s.cost === null).length };
}

/**
 * The beads of a batch: every worktree row with its batch_id (dispatched at least once) plus the beads whose `overseer:batch:<id>`
 * label names it and that were never dispatched (round 15: a bead created for the batch and still waiting in Ready was not
 * counted, so "1 closed of 1" stood next to a card of the batch). `beads` is the repo's bd list; an undispatched bead that
 * is closed (Close bead on its card, or the abandon) counts as closed. One closed outside Overseer (a plain `bd close`, no
 * phase label) has no card, so it is not a member either (fix round 15 review).
 */
export function batchMembers(db: Db, batchId: string, beads: Bead[]): { total: number; done: number; closed: number } {
  const wts = db.worktrees.forBatch(batchId);
  const dispatched = new Set(wts.map((w) => w.bead_id));
  const labelled = beads.filter((b) => b.labels.includes(`${BATCH_PREFIX}${batchId}`) && !dispatched.has(b.id) && (b.status !== 'closed' || phaseOf(b)));
  return {
    total: wts.length + labelled.length,
    done: wts.filter((w) => w.merged_at).length,
    closed: wts.filter((w) => w.closed_at).length + labelled.filter((b) => b.status === 'closed').length,
  };
}

export function batchSummaries(db: Db, repoId: string, beads: Bead[]): BatchSummary[] {
  return db.batches.forRepo(repoId).map((b) => {
    const wts = db.worktrees.forBatch(b.id);
    const { total: cost, unknown: cost_unknown } = costOf(wts.flatMap((w) => db.sessions.forBead(w.bead_id)));
    const m = batchMembers(db, b.id, beads);
    const linked = new Set(db.chatLinks.forBatch(b.id));
    if (b.origin_chat_id !== null && b.origin_chat_id !== undefined) linked.add(b.origin_chat_id);
    return { ...b, linked_chat_ids: [...linked].sort((a, c) => a - c), beads_total: m.total, beads_done: m.done, beads_closed: m.closed, cost, cost_unknown };
  });
}

/**
 * Shares one in-flight promise between callers; a call after settlement starts a new build. `version()` is a monotonic
 * change counter: when it moved after the running build began, callers arriving meanwhile get one shared follow-up build
 * instead of the stale result (the Review list otherwise lags behind a status change that landed during a slow build).
 */
export function coalesced<T>(build: () => Promise<T>, version: () => number = () => 0): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  let builtAt = 0;
  let queued: Promise<T> | null = null;
  const get = (): Promise<T> => {
    if (!inflight) {
      builtAt = version();
      inflight = build().finally(() => { inflight = null; });
      return inflight;
    }
    if (version() === builtAt) return inflight;
    if (!queued) queued = inflight.catch(() => undefined).then(() => { queued = null; return get(); });
    return queued;
  };
  return get;
}

/**
 * The ids `bd ready` would report. `bd ready` costs as much as `bd list`; a bead with no dependencies cannot be blocked,
 * so the extra call is only made when some open bead has one.
 */
export async function readySet(store: TaskStore, repoPath: string, beads: Bead[]): Promise<Set<string>> {
  const needsReady = beads.some((b) => b.status !== 'closed' && b.dependency_count > 0);
  return new Set(needsReady ? await store.ready(repoPath) : beads.filter((b) => b.status === 'open').map((b) => b.id));
}

/** How much of a failed verify output travels with the card: enough for the Review header and the chip's tooltip. */
const VERIFY_TAIL = 600;

/**
 * A Done card carries the bead without its description and notes: the board payload is dominated by them (1.07 MB of the
 * 2.76 MB `/api/board` for this repo, re-fetched on every board socket message), the Done column renders neither, and the
 * pane fetches the full bead from `GET /api/tasks/:id` when it opens one of these cards.
 */
function slimDone(bead: Bead): Bead {
  return { ...bead, description: '', notes: '' };
}

async function cardsFor(db: Db, store: TaskStore, repo: Repo, beads: Bead[], jobs?: ActionJobs): Promise<BoardCard[]> {
  const ready = await readySet(store, repo.path, beads);
  const now = Date.now();
  const cards = beads.flatMap((bead): BoardCard[] => {
    // A discussion participant is not a worker: it runs in its own throwaway worktree with no bead, and even a stray row
    // naming one must never drive a card's harness, model or state.
    const sessions = db.sessions.forBead(bead.id).filter((s) => s.role !== 'discussion');
    const wt = db.worktrees.get(bead.id);
    // Done shows only beads Overseer handled; beads the repo closed on its own would otherwise pile up there forever.
    if (bead.status === 'closed' && !phaseOf(bead) && sessions.length === 0 && !wt) return [];
    const s = sessions[sessions.length - 1];
    const account = s?.account ? db.accounts.get(s.account) : null;
    // The chip names who did the work: the last worker, not the critic that reviewed it.
    const w = sessions.filter((x) => x.role === 'worker').at(-1) ?? s;
    const labelHarness = bead.labels.find((l) => l.startsWith(HARNESS_PREFIX))?.slice(HARNESS_PREFIX.length);
    const harness = (HARNESSES as string[]).includes(labelHarness ?? '') ? (labelHarness as HarnessName) : w?.harness ?? null;
    const elapsed = s ? (s.ended_at ? Date.parse(s.ended_at) : now) - Date.parse(s.started_at) : null;
    // `list` and `ready` are two bd reads half a second apart: a dispatch in between leaves the bead open in the first and gone from
    // the second, and the card flashed through Blocked (round 14). The daemon's own session row says it is running.
    const column = s?.status === 'running' && bead.status === 'open' && !phaseOf(bead) ? 'running' : columnFor(bead, ready);
    // A re-dispatched bead is running, not failed: the old failure stays in the worktree row for the next verification, but the card, the rail badge and the Review header count what is failed now (round 9).
    const verifyFailure = wt?.verify_status === 'fail' && !wt.merged_at && column !== 'running' && column !== 'verifying' ? (wt.verify_output ?? '').slice(-VERIFY_TAIL) : null;
    // One word the web drives every card action from (round 11: the pane offered Retry / Re-dispatch to a worker that had exited but not settled).
    // The row says the bead landed on its batch branch while bd still has it open: bd failed after the merge, and the pane offers Retry close (fix round 16 review).
    // A critic reviews the branch (Stop is the only action); a bead parked with findings after its last round waits for the user's decision.
    const state: CardState = s?.role === 'critic' && s.status === 'running' ? 'reviewing'
      : wt?.review_findings && !wt.merged_at && bead.status !== 'closed' ? 'awaiting_decision'
      : wt?.merged_at && wt.batch_id && bead.status !== 'closed' ? 'landed_unclosed'
      : column === 'done' ? 'done'
      : column === 'verifying' ? 'verifying'
      : column === 'running' ? (s?.status === 'running' ? 'running' : 'settling')
      : column === 'blocked' ? 'blocked' // waits on another bead: no dispatch action, whatever its last verification said (fix round 11 review)
      : verifyFailure !== null ? 'verify_failed'
      : column === 'review' ? 'review'
      : 'idle';
    // Exactly what the task pane renders for this bead's verification, so its loading placeholder reserves that block and no other.
    const verifyBlock: BoardCard['verify_block'] = !wt?.verify_output ? 'none' : wt.verify_output === NO_VERIFY_RUN ? 'label' : 'output';
    // A never-dispatched bead belongs to its batch through the label, so its card sits under the batch like the dispatched ones;
    // a label naming a batch this install does not have (the repo was removed and registered again) is ignored (fix round 15 review).
    const labelled = batchOf(bead);
    return [{ bead: column === 'done' ? slimDone(bead) : bead, repo_id: repo.id, batch_id: wt?.batch_id ?? (labelled && db.batches.get(labelled) ? labelled : null), column, state, harness, branch: wt?.branch ?? null, cost: s?.cost ?? null, elapsed_ms: elapsed, session_status: s?.status ?? null, session_id: s?.id ?? null, verify_failure: verifyFailure, verify_block: verifyBlock, tier: w?.tier ?? null, model: w?.model ?? null, account: s?.account ?? null, account_name: account?.name ?? null, account_label: account?.label ?? null, findings: wt?.review_findings ?? null, accepted_note: wt?.accepted_note ?? null, pending_action: jobs?.pending('bead', bead.id) ?? null }];
  });
  // Newest closed beads first, so a Done column that shows only the first few shows the recent ones.
  const closedAt = (c: BoardCard) => Date.parse(c.bead.closed_at ?? '') || 0;
  const done = cards.filter((c) => c.column === 'done').sort((a, b) => closedAt(b) - closedAt(a));
  return [...cards.filter((c) => c.column !== 'done'), ...done];
}
