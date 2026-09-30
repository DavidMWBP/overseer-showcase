import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';
import { MemoryTaskStore } from '../beads/memory';
import { LocalMergeProvider } from '../git/provider';
import { mkTmpRepo, shAsync } from '../test/tmpgit';
import { loadConfig } from '../config';
import { gitCalls } from '../test/execCalls';
import { log } from '../util/log';
import { Lifecycle, batchWorktreePath } from './lifecycle';

// Records every git spawn and delegates to the real one, so a test can count `branch --list` and `branch -D` calls.
vi.mock('node:child_process', async (orig) => (await import('../test/execCalls')).recordingChildProcess(await orig()));

function setup() {
  const t = mkTmpRepo();
  const db = openDb(':memory:', { batchIdSuffix: () => '' });
  const bus = new Bus();
  const fake = new FakeAdapter();
  const codex = new FakeAdapter('codex');
  const opencode = new FakeAdapter('opencode');
  const sessions = new SessionManager(db, { claude: fake, codex, opencode }, bus, path.join(path.dirname(t.worktreesDir), 'sessions'));
  const store = new MemoryTaskStore();
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null };
  db.repos.insert(repo);
  store.add(repo.path, { id: 'ov-1', title: 'Add greeting', description: 'Write hello.txt' });
  const config = { ...loadConfig({}), worktreesDir: t.worktreesDir, dataDir: path.dirname(t.worktreesDir), orchestratorDir: path.join(path.dirname(t.worktreesDir), 'orchestrator') };
  const notes: string[] = [];
  const lc = new Lifecycle({
    db, store, sessions, bus, config,
    doctorRunner: async () => ({ code: 0, stdout: 'claude 2.1.0', stderr: '' }),
    usageGate: async () => ({ usable: true }),
    reapEnded: async () => [],
    provider: () => new LocalMergeProvider(),
    refreshRetryMs: 0,
    notify: async (m) => { notes.push(m); },
  });
  return { db, bus, sessions, store, repo, lc, notes, worktreesDir: t.worktreesDir };
}

describe('batch branch cleanup fallback', () => {
  it('deletes the batch branch on a normal cleanup with a single branch check', async () => {
    const x = setup();
    const batch = await x.lc.createBatch('r1', 'Normal');
    const lists = gitCalls(x.repo.path, ['branch', '--list', batch.branch]);
    const deletes = gitCalls(x.repo.path, ['branch', '-D', batch.branch]);

    await x.lc.abandonBatch(batch.id);

    // removeWorktree deletes the branch it is given; the fallback must not add a second `branch --list` on the success path.
    expect(gitCalls(x.repo.path, ['branch', '--list', batch.branch]) - lists).toBe(1);
    expect(gitCalls(x.repo.path, ['branch', '-D', batch.branch]) - deletes).toBe(1);
    expect(await shAsync(x.repo.path, ['branch', '--list', batch.branch])).toBe('');
  });

  it('deletes the batch branch when the worktree removal fails', async () => {
    const x = setup();
    const batch = await x.lc.createBatch('r1', 'Fallback');
    const batchPath = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    // Detach the worktree from its branch so the branch is free to delete, then lock it: `git worktree remove --force` refuses
    // the locked worktree on every retry, so the removal fails and only the fallback can still delete the branch.
    await shAsync(batchPath, ['checkout', '--detach']);
    await shAsync(x.repo.path, ['worktree', 'lock', batchPath]);
    const deletes = gitCalls(x.repo.path, ['branch', '-D', batch.branch]);
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await x.lc.abandonBatch(batch.id);
      const messages = errors.mock.calls.map((c) => c[0]);
      expect(messages).toContainEqual(`lifecycle: could not remove ${batchPath}`);
      expect(gitCalls(x.repo.path, ['branch', '-D', batch.branch]) - deletes).toBe(1);
      expect(await shAsync(x.repo.path, ['branch', '--list', batch.branch])).toBe('');
    } finally {
      errors.mockRestore();
    }
  });

  it('logs a failed fallback delete and does not throw', async () => {
    const x = setup();
    const batch = await x.lc.createBatch('r1', 'Locked');
    const batchPath = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    // A locked worktree refuses `worktree remove --force` on every retry, and the branch it still checks out refuses to be deleted too.
    await shAsync(x.repo.path, ['worktree', 'lock', batchPath]);
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await expect(x.lc.abandonBatch(batch.id)).resolves.toBeUndefined();
      const messages = errors.mock.calls.map((c) => c[0]);
      expect(messages).toContainEqual(`lifecycle: could not remove ${batchPath}`);
      expect(messages).toContainEqual(`lifecycle: could not delete ${batch.branch}`);
      expect(await shAsync(x.repo.path, ['branch', '--list', batch.branch])).not.toBe('');
    } finally {
      errors.mockRestore();
      await shAsync(x.repo.path, ['worktree', 'unlock', batchPath]);
    }
  });
});
