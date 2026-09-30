import { randomUUID } from 'node:crypto';
import type { ActionResult, PendingAction } from '@overseer/shared';
import type { Bus } from '../bus';
import { log } from '../util/log';

/** Which board row a job runs for: a bead card or a batch row. */
export type ActionTargetKind = 'bead' | 'batch';

/** A second action for a target whose job is already running: answers 409 with the running job's id instead of starting another. */
export class JobConflictError extends Error {
  constructor(readonly action: string, readonly job_id: string, readonly target: string) {
    super(`${action} is already running for ${target}`);
    this.name = 'JobConflictError';
  }
}

interface Job { job_id: string; action: string; target: string; started_at: string }

/**
 * The in-memory registry of background actions a REST action endpoint acknowledges with 202. One job per target at a
 * time; every job ends with an `action_result` notice and a `board` refresh, and one that starts also refreshes the
 * board so the target's row carries its `pending_action`. Nothing survives a daemon restart, so a reload after one
 * shows no pending action.
 */
export class ActionJobs {
  private running = new Map<string, Job>();
  constructor(private readonly bus: Bus) {}

  private static key(kind: ActionTargetKind, id: string): string { return `${kind}:${id}`; }

  /** The action running for a target right now, for its board row; null when none does. */
  pending(kind: ActionTargetKind, id: string): PendingAction | null {
    const job = this.running.get(ActionJobs.key(kind, id));
    return job ? { job_id: job.job_id, action: job.action, started_at: job.started_at } : null;
  }

  /** Throws `JobConflictError` when a job runs for the target: checked before a route validates, since a running job may already have changed the row. */
  assertIdle(kind: ActionTargetKind, id: string): void {
    const existing = this.running.get(ActionJobs.key(kind, id));
    if (existing) throw new JobConflictError(existing.action, existing.job_id, existing.target);
  }

  /**
   * Runs `fn` in the background and returns the job at once. A second call for the same target throws
   * `JobConflictError` naming the running action. `fn` resolves to the `data` the result carries (what the endpoint
   * returned before the 202); a throw is reported as `ok: false` and logged.
   */
  start(kind: ActionTargetKind, id: string, action: string, fn: () => Promise<unknown>): Job {
    this.assertIdle(kind, id);
    const key = ActionJobs.key(kind, id);
    const job: Job = { job_id: `job-${randomUUID()}`, action, target: id, started_at: new Date().toISOString() };
    this.running.set(key, job);
    this.bus.emit('board');
    void this.finish(key, job, fn);
    return job;
  }

  private async finish(key: string, job: Job, fn: () => Promise<unknown>): Promise<void> {
    let ok = true;
    let message: string | null = null;
    let data: unknown = null;
    try {
      data = (await fn()) ?? null;
    } catch (err) {
      ok = false;
      message = err instanceof Error ? err.message : String(err);
      // The REST error handler is not on this path: a background failure is logged here, with the stack a request's 500 kept.
      log.error('rest: action failed', { action: job.action, target: job.target, job_id: job.job_id, error: message, stack: err instanceof Error ? err.stack : undefined });
    } finally {
      this.running.delete(key);
      const result: ActionResult = { job_id: job.job_id, action: job.action, target: job.target, ok, message, data };
      this.bus.emit('action_result', result);
      this.bus.emit('board');
    }
  }
}
