import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { ActionResult, BatchRow, BoardResponse, BoardCard, BatchSummary, Repo, SessionRow, WorktreeRow } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { MemoryTaskStore } from '../beads/memory';
import { loadConfig } from '../config';
import { buildApp } from '../app';
import { ActionJobs } from './jobs';
import type { Lifecycle } from '../lifecycle/lifecycle';
import type { SessionManager } from '../sessions/manager';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { Plans } from '../plans/plans';
import type { Discussions } from '../discussions/discussions';
import type { Servers } from '../servers/servers';
import type { AccountLogins } from '../accounts/login';
import type { Prober } from '../lifecycle/probe';
import { log } from '../util/log';
import { until } from '../test/until';
import { FakeAdapter } from '../harness/fake';
import { SessionManager as RealSessions } from '../sessions/manager';
import { Lifecycle as RealLifecycle } from '../lifecycle/lifecycle';
import { LocalMergeProvider, type GitProvider } from '../git/provider';
import { mkTmpRepo, commitFileAsync } from '../test/tmpgit';
import { phaseOf } from '../beads/store';

type StubName = 'merge' | 'reject' | 'interruptBead' | 'reverify' | 'closeBead' | 'closeLanded' | 'redispatch' | 'acceptReview' | 'mergeBatch' | 'rejectBatch' | 'abandonBatch';
type LifecycleStub = Record<StubName, ReturnType<typeof vi.fn>>;

interface Deferred { promise: Promise<unknown>; resolve: (value?: unknown) => void; value: unknown }
function deferred(value: unknown): Deferred {
  let resolve!: (v?: unknown) => void;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  return { promise, resolve, value };
}

interface Ctx { app: FastifyInstance; db: ReturnType<typeof openDb>; bus: Bus; store: MemoryTaskStore; jobs: ActionJobs; lifecycle: LifecycleStub; dataDir: string; wtDir: string; results: ActionResult[]; defer: Partial<Record<StubName, Deferred>> }

function setup(): Ctx {
  const db = openDb(':memory:');
  const bus = new Bus();
  const store = new MemoryTaskStore();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-actions-'));
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0 };
  const jobs = new ActionJobs(bus);
  const lifecycle: LifecycleStub = {
    merge: vi.fn(), reject: vi.fn(), interruptBead: vi.fn(), reverify: vi.fn(), closeBead: vi.fn(),
    closeLanded: vi.fn(), redispatch: vi.fn(), acceptReview: vi.fn(), mergeBatch: vi.fn(), rejectBatch: vi.fn(), abandonBatch: vi.fn(),
  };
  const app = buildApp({
    db, bus, store, config, jobs,
    lifecycle: lifecycle as unknown as Lifecycle,
    sessions: {} as SessionManager,
    orchestrator: {} as Orchestrator,
    plans: {} as Plans,
    discussions: {} as Discussions,
    servers: {} as Servers,
    daemon: { pid: 1, startedAt: '2026-09-15T00:00:00.000Z', commit: null, sourceRoot: '/x', sourceHead: async () => null, relaunch: async () => undefined, restarting: false },
    logins: { close: () => {} } as unknown as AccountLogins,
    prober: {} as Prober,
  });
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-actions-wt-'));
  const results: ActionResult[] = [];
  bus.on('action_result', (r) => results.push(r));
  return { app, db, bus, store, jobs, lifecycle, dataDir, wtDir, results, defer: {} };
}

const REPO: Repo = { id: 'r1', path: '/r1', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 0, model_filter: null };
const STARTED = '2026-09-15T00:00:00.000Z';

function batchRow(id: string, status: BatchRow['status']): BatchRow {
  return { id, repo_id: 'r1', title: id, branch: `feature/${id}`, base_branch: 'main', status, note: null, history: null, mr_url: null, conflict_files: null, created_at: STARTED, updated_at: STARTED, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null };
}

function sessionRow(beadId: string): SessionRow {
  return { id: `s-${beadId}`, harness: 'claude', role: 'worker', bead_id: beadId, repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: 'abc', cwd: '/wt', status: 'running', started_at: STARTED, ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null };
}

function seed(c: Ctx): void {
  expect(c.dataDir).not.toBe(loadConfig({}).dataDir);
  c.db.repos.insert(REPO);
  const wt = (beadId: string, over: Partial<WorktreeRow> = {}) => {
    const dir = path.join(c.wtDir, beadId);
    fs.mkdirSync(dir, { recursive: true });
    c.db.worktrees.upsert({
      bead_id: beadId, repo_id: 'r1', path: dir, branch: `bead/${beadId}`, base_branch: 'main',
      verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null,
      batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null, ...over,
    });
  };
  for (const id of ['ov-merge', 'ov-merge2', 'ov-reject', 'ov-verify', 'ov-close', 'ov-redispatch', 'ov-interrupt']) {
    c.store.add('/r1', { id, title: id });
    wt(id);
  }
  c.store.add('/r1', { id: 'ov-landed', title: 'ov-landed' });
  wt('ov-landed', { merged_at: STARTED, batch_id: 'r1-ba' });
  // Retry verification of a batch bead reads the batch's status; a job that only learns it later would report ok:false for a
  // refusal the daemon knows from its rows.
  for (const [id, batch] of [['ov-batchverify', 'r1-br'], ['ov-batchopen', 'r1-ba'], ['ov-nobatch', 'r1-nope']] as const) {
    c.store.add('/r1', { id, title: id });
    wt(id, { batch_id: batch });
  }
  c.store.add('/r1', { id: 'ov-accept', title: 'ov-accept' });
  wt('ov-accept', { review_findings: [{ file: 'a.ts', summary: 'fix it', severity: 'must' }] });
  c.db.sessions.insert(sessionRow('ov-interrupt'));
  c.db.batches.insert(batchRow('r1-bm', 'review'));
  c.db.batches.insert(batchRow('r1-br', 'review'));
  c.db.batches.insert(batchRow('r1-ba', 'open'));
}

let c: Ctx;
beforeEach(() => { c = setup(); seed(c); });
afterEach(async () => {
  releaseAll();
  await c.app.close();
  fs.rmSync(c.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(c.wtDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** Stub a lifecycle method with a promise that does not settle until `releaseAll()`: the reply must not wait for it. */
function slow(method: StubName, value: unknown = undefined): Deferred {
  const d = deferred(value);
  c.defer[method] = d;
  c.lifecycle[method].mockReturnValue(d.promise);
  return d;
}
function releaseAll(): void {
  for (const d of Object.values(c.defer)) d.resolve(d.value);
}

const json = async (url: string, body?: object) => {
  const r = await c.app.inject({ method: 'POST', url, payload: body });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const board = async (): Promise<BoardResponse> => (await c.app.inject({ method: 'GET', url: '/api/board' })).json();
const cardOf = (b: BoardResponse, id: string): BoardCard => b.repos[0]!.cards.find((x) => x.bead.id === id)!;
const batchOf = (b: BoardResponse, id: string): BatchSummary => b.repos[0]!.batches.find((x) => x.id === id)!;

describe('background actions', () => {
  it('replies 202 with a job for every action before its lifecycle call resolves', async () => {
    slow('merge', {});
    slow('mergeBatch', {});
    slow('reject');
    slow('rejectBatch');
    slow('abandonBatch');
    slow('interruptBead');
    slow('reverify', { done: Promise.resolve(null) });
    slow('closeBead');
    slow('closeLanded');
    slow('redispatch', 'sess-1');
    slow('acceptReview');

    const cases = [
      { url: '/api/tasks/ov-merge/merge', action: 'merge', target: 'ov-merge' },
      { url: '/api/tasks/ov-reject/reject', action: 'reject', target: 'ov-reject', payload: { note: 'no' } },
      { url: '/api/tasks/ov-interrupt/interrupt', action: 'interrupt', target: 'ov-interrupt' },
      { url: '/api/tasks/ov-verify/verify', action: 'verify', target: 'ov-verify' },
      { url: '/api/tasks/ov-close/close', action: 'close', target: 'ov-close', payload: {} },
      { url: '/api/tasks/ov-landed/close-landed', action: 'close-landed', target: 'ov-landed' },
      { url: '/api/tasks/ov-redispatch/redispatch', action: 'redispatch', target: 'ov-redispatch' },
      { url: '/api/tasks/ov-accept/accept-review', action: 'accept-review', target: 'ov-accept', payload: { note: 'land it' } },
      { url: '/api/batches/r1-bm/merge', action: 'merge', target: 'r1-bm' },
      { url: '/api/batches/r1-br/reject', action: 'reject', target: 'r1-br', payload: { note: 'no' } },
      { url: '/api/batches/r1-ba/abandon', action: 'abandon', target: 'r1-ba' },
    ];
    for (const tc of cases) {
      const r = await json(tc.url, tc.payload);
      expect({ url: tc.url, ...r }).toMatchObject({ url: tc.url, status: 202, body: { action: tc.action, target: tc.target } });
      expect((r.body as { job_id: string }).job_id).toBeTruthy();
      expect(c.jobs.pending(tc.url.includes('/batches/') ? 'batch' : 'bead', tc.target)).toMatchObject({ job_id: (r.body as { job_id: string }).job_id, action: tc.action });
    }
    // Nothing settled yet: the lifecycle calls are all still pending.
    expect(c.results).toHaveLength(0);
    releaseAll();
    await until(() => cases.every((tc) => c.jobs.pending(tc.url.includes('/batches/') ? 'batch' : 'bead', tc.target) === null));
    expect(c.results).toHaveLength(11);
    expect(c.results.every((r) => r.ok)).toBe(true);
  });

  it('runs two jobs on different targets at the same time', async () => {
    slow('merge', {});
    const a = await json('/api/tasks/ov-merge/merge');
    const b = await json('/api/tasks/ov-merge2/merge');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect((a.body as { job_id: string }).job_id).not.toBe((b.body as { job_id: string }).job_id);
    expect(c.lifecycle.merge).toHaveBeenCalledTimes(2);
    expect(c.jobs.pending('bead', 'ov-merge')).not.toBeNull();
    expect(c.jobs.pending('bead', 'ov-merge2')).not.toBeNull();
  });

  it('refuses a second action for a target that already has a running job, naming the one that runs', async () => {
    const running = slow('reverify', { done: new Promise(() => {}) });
    const first = await json('/api/tasks/ov-verify/verify');
    expect(first.status).toBe(202);
    const second = await json('/api/tasks/ov-verify/verify');
    expect(second).toEqual({ status: 409, body: { error: expect.stringContaining('verify'), job_id: (first.body as { job_id: string }).job_id, action: 'verify' } });
    // A different action on the same target is refused the same way, naming the action that runs, and never starts.
    const close = await json('/api/tasks/ov-verify/close', {});
    expect(close).toMatchObject({ status: 409, body: { job_id: (first.body as { job_id: string }).job_id, action: 'verify' } });
    expect(c.lifecycle.closeBead).not.toHaveBeenCalled();
    expect(running.promise).toBeInstanceOf(Promise);
  });

  it('answers 409 to a second click after the first job already changed the row, as reject and abandon do', async () => {
    // The real rejectBatch moves the batch back to open, and abandonBatch marks it abandoned, before either finishes.
    const reject = deferred(undefined);
    c.lifecycle.rejectBatch.mockImplementation(async () => { c.db.batches.update('r1-br', { status: 'open' }); await reject.promise; });
    c.defer.rejectBatch = reject;
    const abandon = deferred(undefined);
    c.lifecycle.abandonBatch.mockImplementation(async () => { c.db.batches.update('r1-ba', { status: 'abandoned' }); await abandon.promise; });
    c.defer.abandonBatch = abandon;
    const merge = deferred(undefined);
    c.lifecycle.merge.mockImplementation(async () => { c.db.worktrees.delete('ov-merge'); await merge.promise; return {}; });
    c.defer.merge = merge;

    const rejected = await json('/api/batches/r1-br/reject', { note: 'no' });
    expect(rejected.status).toBe(202);
    expect(c.db.batches.get('r1-br')!.status).toBe('open');
    for (const url of ['/api/batches/r1-br/reject', '/api/batches/r1-br/merge']) {
      expect(await json(url, { note: 'again' })).toEqual({ status: 409, body: { error: 'reject is already running for r1-br', job_id: (rejected.body as { job_id: string }).job_id, action: 'reject' } });
    }
    const abandoned = await json('/api/batches/r1-ba/abandon');
    expect(abandoned.status).toBe(202);
    expect(c.db.batches.get('r1-ba')!.status).toBe('abandoned');
    expect(await json('/api/batches/r1-ba/abandon')).toEqual({ status: 409, body: { error: 'abandon is already running for r1-ba', job_id: (abandoned.body as { job_id: string }).job_id, action: 'abandon' } });
    const merged = await json('/api/tasks/ov-merge/merge');
    expect(merged.status).toBe(202);
    expect(await json('/api/tasks/ov-merge/redispatch')).toEqual({ status: 409, body: { error: 'merge is already running for ov-merge', job_id: (merged.body as { job_id: string }).job_id, action: 'merge' } });
    expect(c.lifecycle.rejectBatch).toHaveBeenCalledTimes(1);
    expect(c.lifecycle.abandonBatch).toHaveBeenCalledTimes(1);
    expect(c.lifecycle.redispatch).not.toHaveBeenCalled();
    // Once the job ends, the row's own state answers again.
    releaseAll();
    await until(() => c.jobs.pending('batch', 'r1-br') === null && c.jobs.pending('batch', 'r1-ba') === null);
    expect(await json('/api/batches/r1-br/reject', { note: 'again' })).toEqual({ status: 400, body: { error: 'batch r1-br is not in review' } });
    expect(await json('/api/batches/r1-ba/abandon')).toEqual({ status: 400, body: { error: 'batch r1-ba is abandoned' } });
  });

  it('shows pending_action on the bead and batch rows while a job runs and clears it when it ends', async () => {
    slow('merge', {});
    slow('mergeBatch', {});
    await json('/api/tasks/ov-merge/merge');
    await json('/api/batches/r1-bm/merge');
    const before = await board();
    expect(cardOf(before, 'ov-merge').pending_action).toMatchObject({ action: 'merge' });
    expect(batchOf(before, 'r1-bm').pending_action).toMatchObject({ action: 'merge' });
    expect(cardOf(before, 'ov-reject').pending_action ?? null).toBeNull();
    expect(batchOf(before, 'r1-br').pending_action ?? null).toBeNull();
    releaseAll();
    await until(async () => cardOf(await board(), 'ov-merge').pending_action === null);
    const after = await board();
    expect(cardOf(after, 'ov-merge').pending_action).toBeNull();
    expect(batchOf(after, 'r1-bm').pending_action).toBeNull();
  });

  it('broadcasts action_result with ok true on success and ok false when the lifecycle throws', async () => {
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      slow('merge', {});
      const ok = await json('/api/tasks/ov-merge/merge');
      releaseAll();
      await until(() => c.results.length === 1);
      expect(c.results[0]).toMatchObject({ job_id: (ok.body as { job_id: string }).job_id, action: 'merge', target: 'ov-merge', ok: true, message: null, data: { mr_url: null } });

      c.lifecycle.mergeBatch.mockRejectedValue(new Error('batch r1-bm is being merged'));
      const bad = await json('/api/batches/r1-bm/merge');
      await until(() => c.results.length === 2);
      expect(c.results[1]).toMatchObject({ job_id: (bad.body as { job_id: string }).job_id, action: 'merge', target: 'r1-bm', ok: false, message: 'batch r1-bm is being merged', data: null });
    } finally { logError.mockRestore(); }
  });

  it('logs the failure with its stack, as the request path did', async () => {
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('kaboom');
      c.lifecycle.mergeBatch.mockRejectedValue(boom);
      await json('/api/batches/r1-bm/merge');
      await until(() => c.results.length === 1);
      expect(c.results[0]).toMatchObject({ ok: false, message: 'kaboom' });
      const call = logError.mock.calls.find(([msg]) => msg === 'rest: action failed');
      expect(call).toBeTruthy();
      // A background failure must keep the stack in daemon.log, as a request's 500 did.
      expect((call![1] as { stack?: string } | undefined)?.stack).toBe(boom.stack);
    } finally { logError.mockRestore(); }
  });

  it("carries redispatch's session_id in the action result data", async () => {
    slow('redispatch', 'sess-42');
    const r = await json('/api/tasks/ov-redispatch/redispatch');
    expect(r.status).toBe(202);
    releaseAll();
    await until(() => c.results.length === 1);
    expect(c.results[0]).toMatchObject({ action: 'redispatch', target: 'ov-redispatch', ok: true, data: { session_id: 'sess-42' } });
  });

  it('refuses Retry verification for a batch bead whose batch is not open, before it starts a job', async () => {
    // The daemon's own rows answer this without git or bd work, so it is a 4xx now, not a 202 whose job reports ok:false.
    expect(await json('/api/tasks/ov-batchverify/verify')).toEqual({ status: 400, body: { error: 'batch r1-br is review' } });
    // A batch row that is gone names "missing", the way the lifecycle's own refusal does.
    expect(await json('/api/tasks/ov-nobatch/verify')).toEqual({ status: 400, body: { error: 'batch r1-nope is missing' } });
    expect(c.lifecycle.reverify).not.toHaveBeenCalled();
    expect(c.jobs.pending('bead', 'ov-batchverify')).toBeNull();
    // An open batch still passes the pre-check and starts the job.
    slow('reverify', { done: Promise.resolve(null) });
    expect((await json('/api/tasks/ov-batchopen/verify')).status).toBe(202);
  });

  it('answers a validation failure at once with the status and message the lifecycle uses', async () => {
    expect(await json('/api/tasks/ov-nope/merge')).toEqual({ status: 400, body: { error: 'no worktree for ov-nope' } });
    expect(await json('/api/batches/nope/merge')).toEqual({ status: 400, body: { error: 'batch nope not found' } });
    expect(await json('/api/batches/r1-ba/merge')).toEqual({ status: 400, body: { error: 'batch r1-ba is not in review' } });
    expect((await json('/api/tasks/ov-reject/reject', {})).status).toBe(400);
    expect(await json('/api/tasks/ov-verify/interrupt')).toEqual({ status: 400, body: { error: 'no running worker for ov-verify' } });
    expect(await json('/api/tasks/nope/accept-review', { note: 'x' })).toEqual({ status: 404, body: { error: 'task nope not found' } });
    expect(await json('/api/tasks/ov-verify/close-landed')).toEqual({ status: 400, body: { error: 'ov-verify has not landed on a batch branch' } });
    // Nothing was started and no result was broadcast.
    expect(c.results).toHaveLength(0);
    expect(c.lifecycle.merge).not.toHaveBeenCalled();
    expect(c.lifecycle.reject).not.toHaveBeenCalled();
    expect(c.lifecycle.interruptBead).not.toHaveBeenCalled();
    expect(c.lifecycle.mergeBatch).not.toHaveBeenCalled();
  });
});

describe('Retry verification as a background job', () => {
  /** A real lifecycle on a real repository: the job must follow the verify run, not the call that starts it. */
  async function real(verify: string) {
    const t = mkTmpRepo('ov-actions-');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-actions-real-'));
    const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: t.worktreesDir, orchestratorDir: path.join(dataDir, 'orch') };
    expect(config.dataDir).not.toBe(loadConfig({}).dataDir);
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new FakeAdapter();
    const sessions = new RealSessions(db, { claude: fake }, bus, path.join(dataDir, 'sessions'));
    const store = new MemoryTaskStore();
    db.repos.insert({ ...REPO, path: t.path, verify_command: verify });
    store.add(t.path, { id: 'ov-1', title: 'Add greeting' });
    const lifecycle = new RealLifecycle({ db, store, sessions, bus, config, usageGate: async () => ({ usable: true }), reapEnded: async () => [], provider: () => new LocalMergeProvider(), notify: async () => {} });
    const jobs = new ActionJobs(bus);
    const app = buildApp({
      db, bus, store, config, jobs, lifecycle, sessions,
      orchestrator: {} as Orchestrator, plans: {} as Plans, servers: {} as Servers, discussions: {} as Discussions,
      daemon: { pid: 1, startedAt: STARTED, commit: null, sourceRoot: '/x', sourceHead: async () => null, relaunch: async () => undefined, restarting: false },
      logins: { close: () => {} } as unknown as AccountLogins, prober: {} as Prober,
    });
    const results: ActionResult[] = [];
    bus.on('action_result', (r) => results.push(r));
    // A worker commits and ends: the first verification runs and fails, leaving the bead for a retry.
    const sid = await lifecycle.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => db.worktrees.get('ov-1')?.verify_status === 'fail' && !db.sessions.forBead('ov-1').some((s) => s.status === 'running'), 15_000, 'first verification');
    await until(async () => phaseOf((await store.show(t.path, 'ov-1'))!) === 'review', 15_000, 'in review');
    const cleanup = async () => {
      await app.close();
      // A verify command still running (a failed assertion ends the test early) holds the worktree on Windows: leave the temp folder then.
      for (const dir of [dataDir, t.root]) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp folder */ }
    };
    return { app, db, jobs, results, cleanup, lifecycle, store, path: t.path };
  }

  const SLOW = (code: number, text: string) => `node -e "setTimeout(()=>{console.log('${text}');process.exit(${code})},1500)"`;

  it('stays pending until a slow verification passes, then reports ok true', async () => {
    const r = await real(`node -e "process.exit(1)"`);
    try {
      r.db.repos.update('r1', { verify_command: SLOW(0, 'fine') });
      const res = await r.app.inject({ method: 'POST', url: '/api/tasks/ov-1/verify' });
      expect(res.statusCode).toBe(202);
      const { job_id } = res.json() as { job_id: string };
      // The verify command sleeps 1.5 s: the job is still pending after the call that started the run has returned.
      await new Promise((ok) => setTimeout(ok, 500));
      expect(r.jobs.pending('bead', 'ov-1')).toMatchObject({ job_id, action: 'verify' });
      expect(r.results).toHaveLength(0);
      await until(() => r.results.length === 1, 15_000, 'result');
      expect(r.results[0]).toMatchObject({ job_id, action: 'verify', target: 'ov-1', ok: true, message: null });
      expect(r.db.worktrees.get('ov-1')?.verify_status).toBe('pass');
      expect(r.jobs.pending('bead', 'ov-1')).toBeNull();
    } finally { await r.cleanup(); }
  });

  it('reports ok false with the failure when a slow verification fails', async () => {
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
    const r = await real(`node -e "process.exit(1)"`);
    try {
      r.db.repos.update('r1', { verify_command: SLOW(1, 'still broken') });
      const res = await r.app.inject({ method: 'POST', url: '/api/tasks/ov-1/verify' });
      expect(res.statusCode).toBe(202);
      const { job_id } = res.json() as { job_id: string };
      await new Promise((ok) => setTimeout(ok, 500));
      expect(r.jobs.pending('bead', 'ov-1')).toMatchObject({ job_id, action: 'verify' });
      await until(() => r.results.length === 1, 15_000, 'result');
      expect(r.results[0]).toMatchObject({ job_id, action: 'verify', target: 'ov-1', ok: false });
      expect(r.results[0]!.message).toMatch(/verification failed.*still broken/s);
      expect(r.jobs.pending('bead', 'ov-1')).toBeNull();
    } finally { logError.mockRestore(); await r.cleanup(); }
  });

  it('reports ok true when an already-open bead passes its retry verification', async () => {
    const r = await real(`node -e "process.exit(1)"`);
    try {
      // The user rejected the bead from review: it is open, with its worktree and commits kept for a retry.
      await r.lifecycle.reject('ov-1', 'not quite');
      expect((await r.store.show(r.path, 'ov-1'))?.status).toBe('open');
      r.db.repos.update('r1', { verify_command: `node -e "process.exit(0)"` });
      const res = await r.app.inject({ method: 'POST', url: '/api/tasks/ov-1/verify' });
      expect(res.statusCode).toBe(202);
      await until(() => r.results.length === 1, 15_000, 'result');
      // The retry passed even though the bead was open before it; the old open status alone must not read as a failure.
      expect(r.results[0]).toMatchObject({ action: 'verify', target: 'ov-1', ok: true, message: null });
      expect(r.db.worktrees.get('ov-1')?.verify_status).toBe('pass');
    } finally { await r.cleanup(); }
  });
});

describe('terminal batch actions exclude each other', () => {
  /** A LocalMergeProvider whose batch land waits on a gate, so a Merge can be held in flight against a real REST job. */
  function gatedMerge() {
    const local = new LocalMergeProvider();
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const entered = new Promise<void>((r) => { reached = r; });
    const provider: GitProvider = {
      land: (repo, wt, mr) => local.land(repo, wt, mr),
      async landBatch(repo, batch, wtPath, mr) { reached(); await gate; return local.landBatch(repo, batch, wtPath, mr); },
    };
    return { provider, entered, open };
  }

  it('reports the running action when a REST batch job is refused by the guard', async () => {
    const t = mkTmpRepo('ov-guard-');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-guard-'));
    const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: t.worktreesDir, orchestratorDir: path.join(dataDir, 'orch') };
    expect(config.dataDir).not.toBe(loadConfig({}).dataDir);
    const db = openDb(':memory:');
    const bus = new Bus();
    const fake = new FakeAdapter();
    const sessions = new RealSessions(db, { claude: fake }, bus, path.join(dataDir, 'sessions'));
    const store = new MemoryTaskStore();
    db.repos.insert({ ...REPO, path: t.path, verify_command: `node -e "process.exit(0)"` });
    store.add(t.path, { id: 'ov-1', title: 'Add greeting', description: 'Write hello.txt' });
    const g = gatedMerge();
    const lifecycle = new RealLifecycle({ db, store, sessions, bus, config, usageGate: async () => ({ usable: true }), reapEnded: async () => [], provider: () => g.provider, notify: async () => {} });
    const jobs = new ActionJobs(bus);
    const app = buildApp({
      db, bus, store, config, jobs, lifecycle, sessions,
      orchestrator: {} as Orchestrator, plans: {} as Plans, servers: {} as Servers, discussions: {} as Discussions,
      daemon: { pid: 1, startedAt: STARTED, commit: null, sourceRoot: '/x', sourceHead: async () => null, relaunch: async () => undefined, restarting: false },
      logins: { close: () => {} } as unknown as AccountLogins, prober: {} as Prober,
    });
    const results: ActionResult[] = [];
    bus.on('action_result', (r) => results.push(r));
    try {
      const batchId = (await lifecycle.createBatch('r1', 'Race')).id;
      const sid = await lifecycle.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId });
      await commitFileAsync(db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
      fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
      await until(async () => phaseOf((await store.show(t.path, 'ov-1'))!) === 'merged', 15_000, 'landed on the batch branch');
      await lifecycle.requestBatchReview('r1', batchId, 'Adds hello.txt');
      // A real Merge is in flight: a REST Abandon is refused by the guard, and its job result names the merge.
      const merging = lifecycle.mergeBatch(batchId);
      await g.entered;
      const res = await app.inject({ method: 'POST', url: `/api/batches/${batchId}/abandon` });
      expect(res.statusCode).toBe(202);
      await until(() => results.length === 1, 15_000, 'abandon result');
      expect(results[0]).toMatchObject({ action: 'abandon', target: batchId, ok: false, message: `batch ${batchId} is being merged` });
      g.open();
      await merging;
      expect(db.batches.get(batchId)?.status).toBe('merged');
      expect(results).toHaveLength(1);
    } finally {
      await app.close();
      // A verify command still running (a failed assertion ends the test early) holds the worktree on Windows: leave the temp folder then.
      for (const dir of [dataDir, t.root]) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp folder */ }
    }
  });
});
