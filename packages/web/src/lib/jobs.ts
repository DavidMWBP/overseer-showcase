import { useSyncExternalStore } from 'react';
import type { ActionResult, BoardResponse } from '@overseer/shared';
import { ApiError, isUnreachable } from '../api';
import { refusalToast } from './actions';
import { pushToast } from './toasts';

/**
 * The background actions this page asked for, per target (a bead or a batch id), from the click until the job ends. A view
 * holds a target here while its request is out and after the 202 or 409, so the pressed button keeps reading the action in
 * progress even while the board has not sampled the job's `pending_action` yet. The job ends with its `action_result`,
 * which the app shell passes to `jobEnded`, or with a board requested after the daemon knew of the job whose row carries no
 * job (a result the page missed: a dropped socket, a daemon restart). Module-level, like the toasts, so a pane that closes
 * and reopens, or the Office's copy of it, reads the same state.
 */
interface Held { action: string; jobId: string | null; since: number }

let held = new Map<string, Held>();
/** Job ids whose result has arrived: a 202 or 409 read after its job's end must not hold the target again. */
let ended = new Map<string, ActionResult>();
let watchers = new Map<string, Array<(r: ActionResult) => void>>();
const listeners = new Set<() => void>();
let clock = 0;

function emit(): void { for (const listener of listeners) listener(); }
function drop(target: string): void { if (held.delete(target)) emit(); }

/** A click: holds the target and returns true, or returns false when the target is already held (a second click). */
export function startJob(target: string, action: string): boolean {
  if (held.has(target)) return false;
  held.set(target, { action, jobId: null, since: 0 });
  emit();
  return true;
}

/**
 * The 202 (or the 409 naming the job that already runs): the target is held until that job ends. A 409 passes the action
 * that runs, which need not be the one clicked: the target then reads that action, as its board row will.
 */
export function jobAccepted(target: string, jobId: string, action?: string): void {
  const h = held.get(target);
  if (!h) return;
  if (ended.has(jobId)) { drop(target); return; }
  held.set(target, { action: action ?? h.action, jobId, since: ++clock });
  if (action && action !== h.action) emit();
}

/** The request was refused or never reached the daemon: nothing runs, so nothing is held. */
export function jobRefused(target: string): void { drop(target); }

/** The app shell, on `action_result`: the job's target is released and its watchers are called. */
export function jobEnded(r: ActionResult): void {
  if (ended.has(r.job_id)) return;
  ended.set(r.job_id, r);
  for (const [target, h] of held) if (h.jobId === r.job_id) held.delete(target);
  const calls = watchers.get(r.job_id) ?? [];
  watchers.delete(r.job_id);
  emit();
  for (const call of calls) call(r);
}

/** Calls `fn` once with the job's result: when it arrives, or at once when it already has. */
export function whenJobEnds(jobId: string, fn: (r: ActionResult) => void): void {
  const r = ended.get(jobId);
  if (r) { fn(r); return; }
  watchers.set(jobId, [...(watchers.get(jobId) ?? []), fn]);
}

/** The app shell, before it requests `/board`: the mark `boardLoaded` gets with that request's answer. */
export function boardRequested(): number { return ++clock; }

/**
 * The app shell, when a `/board` answer is applied. A board requested after a job was accepted is the truth about it: a row
 * that no longer carries that job (none, or another one) releases the target. A board requested earlier predates the job.
 */
export function boardLoaded(board: BoardResponse, mark: number): void {
  let changed = false;
  for (const [target, h] of held) {
    if (h.jobId === null || h.since >= mark) continue;
    const row = board.repos.flatMap((r) => r.cards).find((c) => c.bead.id === target) ?? board.repos.flatMap((r) => r.batches).find((b) => b.id === target);
    if (row?.pending_action?.job_id !== h.jobId) { held.delete(target); changed = true; }
  }
  if (changed) emit();
}

/**
 * One action request for a target, from the click to the daemon's answer. Returns null for a second click on a held target
 * and for a refusal (toasted here, the buttons come back); `unreachable` when the daemon was not there (the view says so in
 * place, since nothing was sent); otherwise the job that now runs for the target, `ours` when this request started it (a 202)
 * rather than finding one running (a 409, toasted here with the daemon's words naming the running action).
 */
export async function sendAction(target: string, action: string, post: () => Promise<unknown>): Promise<{ jobId: string; ours: boolean } | { unreachable: true } | null> {
  if (!startJob(target, action)) return null;
  try {
    const { job_id } = (await post()) as { job_id: string };
    jobAccepted(target, job_id);
    return { jobId: job_id, ours: true };
  } catch (e) {
    const conflict = e instanceof ApiError && e.status === 409 ? e.body as { job_id?: unknown; action?: unknown } | null : null;
    const running = conflict?.job_id;
    if (typeof running === 'string') {
      pushToast('failure', (e as ApiError).message);
      jobAccepted(target, running, typeof conflict?.action === 'string' ? conflict.action : undefined);
      return { jobId: running, ours: false };
    }
    jobRefused(target);
    if (isUnreachable(e)) return { unreachable: true };
    pushToast('failure', refusalToast(action, e instanceof ApiError ? e.message : String(e)));
    return null;
  }
}

/** The action held for a target, read outside a render (a click handler); null when none is. */
export function pendingFor(target: string | null): string | null { return target ? held.get(target)?.action ?? null : null; }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The action held for a target, for a render. */
export function usePendingFor(target: string | null): string | null {
  return useSyncExternalStore(subscribe, () => pendingFor(target));
}

/**
 * A board row's running job, for a render: null once that job's result has arrived, since a row sampled before the result
 * (the next board not in yet, or its refetch failed) is stale about it. A row naming another job still counts.
 */
export function useRunningJob<T extends { job_id: string }>(pending: T | null | undefined): T | null {
  return useRunningJobs()(pending);
}

/** The same for a list of rows (a hook cannot run per row): a function reading each row's job, re-rendering as results arrive. */
export function useRunningJobs(): <T extends { job_id: string }>(pending: T | null | undefined) => T | null {
  useSyncExternalStore(subscribe, () => ended.size); // results are only ever added, so the size changes with each one
  return (pending) => (pending && !ended.has(pending.job_id) ? pending : null);
}

/** Tests: a job one test started must not hold the next one's target. */
export function resetJobs(): void { held = new Map(); ended = new Map(); watchers = new Map(); clock = 0; emit(); }
