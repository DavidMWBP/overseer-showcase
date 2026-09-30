import fs from 'node:fs';
import path from 'node:path';
import type { PreflightResult, PreflightRun, PreflightStep } from '@overseer/shared';
import type { Db } from '../db/db';
import type { Bus } from '../bus';
import type { Push } from '../push/push';
import { git, removeWorktree } from '../git/git';
import { log } from '../util/log';
import { runSetup, runVerify, type VerifyResult } from './verify';

export interface ProberDeps { db: Db; bus: Bus; worktreesDir: string; notify: (text: string, opts?: { wake?: boolean; hint?: string }) => Promise<void>; push?: Push }

/** The reason `spawnWorker` refuses a dispatch while a repo's setup or verify command fails on its own base branch. */
export const refusalText = (run: Pick<PreflightRun, 'command' | 'exit_code' | 'result' | 'head_sha' | 'step'>, base: string) => {
  const word = run.result === 'timeout' ? 'times out' : `exits ${run.exit_code}`;
  return `${run.step} command "${run.command}" ${word} on ${base} at ${(run.head_sha ?? '?').slice(0, 7)}; fix it in Setup → Edit, then Re-probe`;
};

/** `runShell` ends its output with `exit <code>` or `(timed out)`; a spawn error (or a kill that reports no code) ends with neither, and is not evidence the command itself fails. */
export function outcome(r: VerifyResult): { result: PreflightResult; exit_code: number | null } {
  if (r.output.endsWith('(timed out)')) return { result: 'timeout', exit_code: null };
  const m = /exit (-?\d+|null)$/.exec(r.output);
  const code = m && m[1] !== 'null' ? Number(m[1]) : null;
  if (r.status === 'pass') return { result: 'pass', exit_code: code };
  return code === null ? { result: 'error', exit_code: null } : { result: 'fail', exit_code: code };
}

/** Runs the repo's setup and verify commands on its base head, so a command that can never pass stops dispatch before a worker runs. */
export class Prober {
  private chains = new Map<string, Promise<void>>();
  constructor(private d: ProberDeps) {}

  probe(repoId: string): Promise<void> {
    const next = (this.chains.get(repoId) ?? Promise.resolve()).then(() => this.run(repoId)).catch((err) => log.error(`probe: ${repoId} failed`, err));
    this.chains.set(repoId, next);
    return next;
  }

  private async run(repoId: string): Promise<void> {
    const { db, bus } = this.d;
    const repo = db.repos.get(repoId);
    if (!repo) return;
    if (!repo.verify_command) {
      if (repo.verify_suspect != null) { db.repos.update(repoId, { verify_suspect: null }); bus.emit('repos'); }
      return;
    }
    const command = repo.verify_command;
    const wtPath = path.join(this.d.worktreesDir, repoId, 'probe');
    let head: string | null = null;
    try { head = await git(repo.path, ['rev-parse', repo.base_branch]); } catch { /* recorded as an error below */ }
    const run = db.preflight.insert({ repo_id: repoId, kind: 'verify_probe', command, head_sha: head });
    let finished: { result: PreflightResult; exit_code: number | null; output_tail: string; step: PreflightStep; command: string };
    try {
      if (!head) throw new Error(`base branch ${repo.base_branch} not found`);
      await git(repo.path, ['worktree', 'prune']);
      if (fs.existsSync(wtPath)) await removeWorktree(repo.path, wtPath, null);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      await git(repo.path, ['worktree', 'add', '--detach', wtPath, head]);
      const setup = repo.setup_command ? await runSetup(repo.setup_command, wtPath) : null;
      const setupFailed = !!setup && setup.status !== 'pass';
      const result = setupFailed ? setup! : await runVerify(command, wtPath);
      finished = { ...outcome(result), output_tail: result.output.slice(-600), step: setupFailed ? 'setup' : 'verify', command: setupFailed ? repo.setup_command! : command };
    } catch (err) {
      finished = { result: 'error', exit_code: null, output_tail: (err instanceof Error ? err.message : String(err)).slice(-600), step: 'verify', command };
    } finally {
      if (fs.existsSync(wtPath)) await removeWorktree(repo.path, wtPath, null).catch((err) => log.error(`probe: could not remove ${wtPath}`, err));
    }
    db.preflight.finish(run.id, finished);
    const was = db.repos.get(repoId)?.verify_suspect ?? null;
    if (finished.result === 'pass') {
      if (was != null) db.repos.update(repoId, { verify_suspect: null });
    } else if (finished.result !== 'error') {
      db.repos.update(repoId, { verify_suspect: run.id });
      if (was == null) {
        const reason = refusalText({ ...run, ...finished }, repo.base_branch);
        await this.d.notify(`Dispatch to ${repoId} is paused: ${reason}.`, { hint: 'Do not dispatch or re-dispatch beads of this repo; spawn_worker refuses until the user fixes the command and the probe passes. Tell the user once.' })
          .catch((err) => log.error('probe: notify failed', err));
        void this.d.push?.notify({ title: `${repoId}: ${finished.step} command fails on ${repo.base_branch}`, body: finished.command, url: '#setup' });
      }
    }
    bus.emit('repos');
  }
}
