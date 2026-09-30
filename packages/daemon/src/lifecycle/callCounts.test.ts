import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';
import { MemoryTaskStore } from '../beads/memory';
import { LocalMergeProvider } from '../git/provider';
import { mkTmpRepo, commitFileAsync } from '../test/tmpgit';
import { until } from '../test/until';
import { loadConfig } from '../config';
import { gitCalls } from '../test/execCalls';
import { Lifecycle } from './lifecycle';

// Records every git spawn and delegates to the real one, so a test can count `git worktree prune` and `branch --list` calls.
vi.mock('node:child_process', async (orig) => (await import('../test/execCalls')).recordingChildProcess(await orig()));

const WAIT = 45_000;

function setup(verify = `node -e "process.exit(0)"`) {
  const t = mkTmpRepo();
  const db = openDb(':memory:', { batchIdSuffix: () => '' });
  const bus = new Bus();
  const fake = new FakeAdapter();
  const codex = new FakeAdapter('codex');
  const opencode = new FakeAdapter('opencode');
  const sessions = new SessionManager(db, { claude: fake, codex, opencode }, bus, path.join(path.dirname(t.worktreesDir), 'sessions'));
  const store = new MemoryTaskStore();
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: verify, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null };
  db.repos.insert(repo);
  store.add(repo.path, { id: 'ov-1', title: 'Add greeting', description: 'Write hello.txt' });
  const notes: string[] = [];
  const config = { ...loadConfig({}), worktreesDir: t.worktreesDir, dataDir: path.dirname(t.worktreesDir), orchestratorDir: path.join(path.dirname(t.worktreesDir), 'orchestrator') };
  const lc = new Lifecycle({
    db, store, sessions, bus, config,
    doctorRunner: async () => ({ code: 0, stdout: 'claude 2.1.0', stderr: '' }),
    usageGate: async () => ({ usable: true }),
    reapEnded: async () => [],
    provider: () => new LocalMergeProvider(),
    refreshRetryMs: 0,
    notify: async (m) => { notes.push(m); },
  });
  const finishTurn = (sid: string) => fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
  return { db, bus, fake, sessions, store, repo, lc, notes, finishTurn };
}

/** Wraps every bd write/read on the store, recording call kinds and the phase label each write carried, in order. */
function instrumentBd(x: ReturnType<typeof setup>) {
  const calls: string[] = [];
  const phases: unknown[] = [];
  const orig = {
    update: x.store.update.bind(x.store), close: x.store.close.bind(x.store), show: x.store.show.bind(x.store),
    list: x.store.list.bind(x.store), ready: x.store.ready.bind(x.store), blocked: x.store.blocked.bind(x.store),
  };
  vi.spyOn(x.store, 'update').mockImplementation(async (p, id, patch) => { calls.push('update'); phases.push(patch.phase); return orig.update(p, id, patch); });
  vi.spyOn(x.store, 'close').mockImplementation(async (p, id, reason, o) => { calls.push('close'); return orig.close(p, id, reason, o); });
  vi.spyOn(x.store, 'show').mockImplementation(async (p, id) => { calls.push('show'); return orig.show(p, id); });
  vi.spyOn(x.store, 'list').mockImplementation(async (p) => { calls.push('list'); return orig.list(p); });
  vi.spyOn(x.store, 'ready').mockImplementation(async (p) => { calls.push('ready'); return orig.ready(p); });
  vi.spyOn(x.store, 'blocked').mockImplementation(async (p) => { calls.push('blocked'); return orig.blocked(p); });
  return { calls, phases };
}

describe.concurrent('call counts', () => {
  it('dispatches into a batch with one prune and one branch check for the bead branch', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Dispatch');
    const prunes = gitCalls(x.repo.path, ['worktree', 'prune']);
    const branchLists = gitCalls(x.repo.path, ['branch', '--list', 'bead/ov-1']);
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });

    expect(gitCalls(x.repo.path, ['worktree', 'prune']) - prunes).toBe(1);
    expect(gitCalls(x.repo.path, ['branch', '--list', 'bead/ov-1']) - branchLists).toBe(1);
  });

  it('shows verifying while the verification runs, writes it once, and lands in five bd calls', async () => {
    const x = setup(`node -e "setTimeout(()=>process.exit(0), 300)"`);
    const bd = instrumentBd(x);
    // The office feed's running event is emitted after the `verifying` write and before the command runs, so the phase at
    // that moment is what the board shows for the whole run.
    const phaseAtRun: unknown[] = [];
    x.bus.on('bead:verify', (e) => { if (e.bead_id === 'ov-1' && e.status === 'running') phaseAtRun.push(bd.phases.at(-1)); });

    await x.lc.createBatch('r1', 'Landing');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    bd.calls.length = 0; // scope the count to the landing
    bd.phases.length = 0;
    x.finishTurn(sid);
    await until(() => x.notes.some((n) => n.includes('landed on')), WAIT, 'landed');

    expect(phaseAtRun).toEqual(['verifying']);
    expect(bd.phases).toEqual(['verifying', 'merged']); // no identical consecutive phase write
    expect(bd.calls).toHaveLength(5);
    expect(bd.calls).toEqual(['show', 'update', 'close', 'update', 'list']);
  });

  it('merges a batch with one prune for the repository', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Merge');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => x.notes.some((n) => n.includes('landed on')), WAIT, 'landed');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'note');

    const prunes = gitCalls(x.repo.path, ['worktree', 'prune']);
    await x.lc.mergeBatch('r1-b1');

    expect(gitCalls(x.repo.path, ['worktree', 'prune']) - prunes).toBe(1);
  });
});
