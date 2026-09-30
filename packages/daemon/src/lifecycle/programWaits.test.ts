import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Program, Repo } from '@overseer/shared';
import { MemoryTaskStore } from '../beads/memory';
import { Bus } from '../bus';
import { loadConfig } from '../config';
import { openDb } from '../db/db';
import { FakeAdapter } from '../harness/fake';
import { LocalMergeProvider } from '../git/provider';
import { SessionManager } from '../sessions/manager';
import { mkTmpRepo, commitFileAsync, shAsync } from '../test/tmpgit';
import { Orchestrator } from '../orchestrator/orchestrator';
import { log } from '../util/log';
import { Lifecycle, batchWorktreePath, type LifecycleDeps } from './lifecycle';
import { GitlabMrWatcher } from './mrWatcher';

vi.setConfig({ maxConcurrency: 2, testTimeout: 90_000 });

const MR_URL = 'https://gitlab.example.com/group/project/-/merge_requests/41';
type Notice = { text: string; options?: Parameters<LifecycleDeps['notify']>[1] };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function makeRuntime(x: Fixture, db: ReturnType<typeof openDb>, notify: LifecycleDeps['notify']) {
  const bus = new Bus();
  const adapter = new FakeAdapter('claude');
  const sessions = new SessionManager(db, { claude: adapter }, bus, path.join(x.dataDir, 'sessions'));
  const lc = new Lifecycle({
    db,
    store: x.store,
    sessions,
    bus,
    config: x.config,
    provider: () => new LocalMergeProvider(),
    notify,
    refreshRetryMs: 0,
  });
  return { db, bus, adapter, sessions, lc };
}

interface Fixture {
  dataDir: string;
  dbPath: string;
  tempRepo: ReturnType<typeof mkTmpRepo>;
  config: ReturnType<typeof loadConfig>;
  store: MemoryTaskStore;
  db: ReturnType<typeof openDb>;
  runtime: ReturnType<typeof makeRuntime>;
  notices: Notice[];
  repo: Repo;
  program: Program;
}

async function setup(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-program-waits-data-'));
  const tempRepo = mkTmpRepo('ov-program-waits-repo-');
  const port = await freePort();
  expect(port).not.toBe(4400);
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port, worktreesDir: path.join(dataDir, 'worktrees') };
  const dbPath = path.join(dataDir, 'overseer.db');
  expect(path.resolve(dbPath)).not.toBe(path.resolve(loadConfig({}).dbPath));
  const db = openDb(dbPath, { batchIdSuffix: () => '' });
  const store = new MemoryTaskStore();
  const repo: Repo = {
    id: 'r1', path: tempRepo.path, base_branch: 'main', verify_command: null, review_command: null, setup_command: null,
    merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null,
  };
  db.repos.insert(repo);
  const program: Program = { id: 'program-test', repo_id: repo.id, title: 'Stories 201 and 202', status: 'open', created_at: new Date().toISOString(), origin_chat_id: null };
  db.programs.insert(program);
  const x = { dataDir, dbPath, tempRepo, config, store, db, notices: [] as Notice[], repo, program } as Fixture;
  x.runtime = makeRuntime(x, db, async (text, options) => { x.notices.push({ text, options }); });
  return x;
}

async function cleanup(x: Fixture): Promise<void> {
  x.db.sql.close();
  fs.rmSync(x.tempRepo.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(x.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function addProgramBatches(x: Fixture, dependentCount = 1) {
  const prerequisite = await x.runtime.lc.createBatch(x.repo.id, 'Prerequisite story');
  const dependents = [];
  for (let i = 0; i < dependentCount; i++) dependents.push(await x.runtime.lc.createBatch(x.repo.id, `Dependent story ${i + 1}`));
  x.db.programBatches.insert({ program_id: x.program.id, batch_id: prerequisite.id, lane: 'shared', position: 0 });
  dependents.forEach((batch, index) => {
    x.db.programBatches.insert({ program_id: x.program.id, batch_id: batch.id, lane: 'shared', position: index + 1 });
    x.db.batchWaits.insert({ batch_id: batch.id, prerequisite_batch_id: prerequisite.id });
  });
  return { prerequisite, dependents };
}

async function makeReviewable(x: Fixture, batchId: string): Promise<void> {
  const batch = x.db.batches.get(batchId)!;
  const wt = batchWorktreePath(x.config.worktreesDir, x.repo.id, batchId);
  await commitFileAsync(wt, `changes/${batchId}.txt`, 'finished\n', 'finish batch');
  await x.runtime.lc.requestBatchReview(x.repo.id, batchId, 'Ready to merge');
}

describe('program prerequisite waits', () => {
  let x: Fixture;

  beforeEach(async () => { x = await setup(); });
  afterEach(async () => { await cleanup(x); });

  it('refuses dispatch until its prerequisite merges and leaves batches without program waits alone', async () => {
    const { prerequisite, dependents } = await addProgramBatches(x);
    const dependent = dependents[0]!;
    x.store.add(x.repo.path, { id: 'ov-waiting', title: 'Waiting bead', labels: [`overseer:batch:${dependent.id}`] });
    x.store.add(x.repo.path, { id: 'ov-free', title: 'Free bead' });
    await x.runtime.lc.requestBatchReview(x.repo.id, prerequisite.id, 'Review first');

    await expect(x.runtime.lc.spawnWorker(x.repo.id, 'ov-waiting', { harness: 'claude', batchId: dependent.id }))
      .rejects.toThrow(`batch ${dependent.id} is waiting on prerequisite batch ${prerequisite.id} (review)`);
    expect(x.db.sessions.running()).toEqual([]);

    const worker = await x.runtime.lc.spawnWorker(x.repo.id, 'ov-free', { harness: 'claude' });
    expect(x.db.sessions.get(worker)).toMatchObject({ status: 'running', bead_id: 'ov-free', batch_id: null });
  });

  it('releases and announces a waiter after a local merge', async () => {
    const { prerequisite, dependents } = await addProgramBatches(x);
    await makeReviewable(x, prerequisite.id);
    await x.runtime.lc.mergeBatch(prerequisite.id);

    expect(x.db.batchWaits.forProgram(x.program.id)).toEqual([
      { batch_id: dependents[0]!.id, prerequisite_batch_id: prerequisite.id, released: true },
    ]);
    expect(x.notices.filter((notice) => notice.text.startsWith('Program '))).toEqual([{
      text: `Program ${x.program.title}: batch ${dependents[0]!.id} can start (${prerequisite.id} merged)`,
      options: { wake: true },
    }]);
  });

  it('releases and announces a waiter when the GitLab MR watcher records the merge', async () => {
    const { prerequisite, dependents } = await addProgramBatches(x);
    const batch = x.db.batches.get(prerequisite.id)!;
    const wt = batchWorktreePath(x.config.worktreesDir, x.repo.id, prerequisite.id);
    await commitFileAsync(wt, 'changes/gitlab.txt', 'merged\n', 'finish MR batch');
    const sha = await shAsync(x.repo.path, ['rev-parse', `refs/heads/${batch.branch}`]);
    x.db.batches.update(prerequisite.id, { status: 'review', mr_url: MR_URL });
    x.db.repos.update(x.repo.id, { merge_mode: 'gitlab-mr' });
    const watcher = new GitlabMrWatcher({
      db: x.db,
      fetchMr: async () => JSON.stringify({ state: 'merged', sha }),
      mergeBatch: (id, actor) => x.runtime.lc.mergeBatch(id, actor),
      notify: async (text, options) => { x.notices.push({ text, options }); },
    });

    await watcher.tick();

    expect(x.db.batches.get(prerequisite.id)?.status).toBe('merged');
    expect(x.db.batchWaits.forProgram(x.program.id)).toEqual([
      { batch_id: dependents[0]!.id, prerequisite_batch_id: prerequisite.id, released: true },
    ]);
    expect(x.notices.filter((notice) => notice.text.startsWith('Program ')).map((notice) => notice.text)).toEqual([
      `Program ${x.program.title}: batch ${dependents[0]!.id} can start (${prerequisite.id} merged)`,
    ]);
  });

  it('keeps a wait held and asks for a decision when its prerequisite is abandoned', async () => {
    const { prerequisite, dependents } = await addProgramBatches(x);
    await x.runtime.lc.abandonBatch(prerequisite.id);

    expect(x.db.batches.get(prerequisite.id)?.status).toBe('abandoned');
    expect(x.db.batchWaits.forProgram(x.program.id)).toEqual([
      { batch_id: dependents[0]!.id, prerequisite_batch_id: prerequisite.id, released: false },
    ]);
    expect(x.notices.filter((notice) => notice.text.startsWith('Program '))).toEqual([{
      text: `Program ${x.program.title}: prerequisite batch ${prerequisite.id} was abandoned; batch ${dependents[0]!.id} remains held. What should happen next?`,
      options: {
        wake: true,
        hint: 'Ask the user what to do before dispatching the waiting batch.',
      },
    }]);
  });

  it('recovers a persisted merge release after restart and emits its notice only once', async () => {
    const { prerequisite, dependents } = await addProgramBatches(x);
    await makeReviewable(x, prerequisite.id);
    let failedBeforePersistingNotice = false;
    const expectedLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    x.runtime = makeRuntime(x, x.db, async (text, options) => {
      if (text.startsWith('Program ')) {
        failedBeforePersistingNotice = true;
        throw new Error('daemon stopped before storing the notice');
      }
      x.notices.push({ text, options });
    });
    try { await x.runtime.lc.mergeBatch(prerequisite.id); } finally { expectedLog.mockRestore(); }
    expect(failedBeforePersistingNotice).toBe(true);
    expect(x.db.batchWaits.forProgram(x.program.id)[0]).toMatchObject({ released: true });
    expect(x.db.batchWaits.pendingReleaseNotices()).toHaveLength(1);

    x.db.sql.close();
    x.db = openDb(x.dbPath, { batchIdSuffix: () => '' });
    x.runtime = makeRuntime(x, x.db, async (text, options) => { x.notices.push({ text, options }); });
    await x.runtime.lc.recover();
    await x.runtime.lc.recover();

    expect(x.db.batchWaits.forProgram(x.program.id)).toEqual([
      { batch_id: dependents[0]!.id, prerequisite_batch_id: prerequisite.id, released: true },
    ]);
    expect(x.notices.filter((notice) => notice.text.startsWith('Program ')).map((notice) => notice.text)).toEqual([
      `Program ${x.program.title}: batch ${dependents[0]!.id} can start (${prerequisite.id} merged)`,
    ]);
    expect(x.db.batchWaits.pendingReleaseNotices()).toEqual([]);
  });

  it('releases every waiter and announces each batch once when two wait on one prerequisite', async () => {
    const { prerequisite, dependents } = await addProgramBatches(x, 2);
    await makeReviewable(x, prerequisite.id);
    await x.runtime.lc.mergeBatch(prerequisite.id);

    expect(x.db.batchWaits.forProgram(x.program.id)).toEqual(dependents.map((batch) => ({
      batch_id: batch.id, prerequisite_batch_id: prerequisite.id, released: true,
    })));
    expect(x.notices.filter((notice) => notice.text.startsWith('Program ')).map((notice) => notice.text)).toEqual(dependents.map((batch) =>
      `Program ${x.program.title}: batch ${batch.id} can start (${prerequisite.id} merged)`));
    expect(() => x.db.batchWaits.insert({ batch_id: dependents[0]!.id, prerequisite_batch_id: prerequisite.id })).toThrow();
  });

  it('releases a newly added wait immediately when its prerequisite is already merged', async () => {
    const prerequisite = await x.runtime.lc.createBatch(x.repo.id, 'Already merged story');
    const dependent = await x.runtime.lc.createBatch(x.repo.id, 'New dependent story');
    x.db.batches.update(prerequisite.id, { status: 'merged' });
    x.db.programBatches.insert({ program_id: x.program.id, batch_id: prerequisite.id, lane: 'shared', position: 0 });
    x.db.programBatches.insert({ program_id: x.program.id, batch_id: dependent.id, lane: 'shared', position: 1 });

    x.db.batchWaits.insert({ batch_id: dependent.id, prerequisite_batch_id: prerequisite.id });

    expect(x.db.batchWaits.forProgram(x.program.id)).toEqual([
      { batch_id: dependent.id, prerequisite_batch_id: prerequisite.id, released: true },
    ]);
    expect(x.db.batchWaits.pendingReleaseNotices()).toEqual([]);
    expect(x.notices.filter((notice) => notice.text.startsWith('Program '))).toEqual([]);
  });

  it('keeps one persisted Chat row when a program release notice is retried', async () => {
    const orchestrator = new Orchestrator({ db: x.db, sessions: x.runtime.sessions, bus: x.runtime.bus, config: x.config });
    const text = `Program ${x.program.title}: batch r1-b2 can start (r1-b1 merged)`;

    await orchestrator.systemMessage(text);
    await orchestrator.systemMessage(text);

    expect(x.db.chat.all().filter((row) => row.text === text)).toHaveLength(1);
    expect(x.db.chat.queued().filter((row) => row.text === text)).toHaveLength(1);
  });
});
