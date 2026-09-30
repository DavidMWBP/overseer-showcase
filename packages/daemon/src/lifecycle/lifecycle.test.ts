import { describe, it as vitestIt, expect, vi, type Mock } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Repo, TierCandidate } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import type { SessionHandle, StartOpts } from '../harness/types';
import { SessionManager } from '../sessions/manager';
import { MemoryTaskStore } from '../beads/memory';
import { phaseOf } from '../beads/store';
import { GitlabMrProvider, LocalMergeProvider, MergeConflictError, type GitProvider, type GlabRunner } from '../git/provider';
import { pushBaseBranch } from '../git/git';
import { mkTmpRepo, commitFileAsync, shAsync } from '../test/tmpgit';
import { until } from '../test/until';
import { fakeBin } from '../test/fakeBin';
import { isAlive, killProcess, pidExists, processStartTime, spawnLines } from '../util/procs';
import { ClaudeAdapter } from '../harness/claude';
import { Lifecycle, LifecycleError, SLUG_MAX, batchWorktreePath, quoteFiles, renderFindings, slug, type LifecycleDeps } from './lifecycle';
import { sweepIdleEnds } from './idle-end';
import { accountUsable } from '../accounts/usage';
import { AUTH_HOLD_UNTIL } from '../accounts/status';
import { isQuietNotice } from '../orchestrator/quietNotices';
import { log } from '../util/log';
import { loadConfig } from '../config';
import { PriceCatalog } from '../pricing/catalog';
import { GitlabMrWatcher } from './mrWatcher';
import { batchSummaries, buildBoard } from '../api/board';
import os from 'node:os';

// The tests run concurrently: each spends most of its time waiting on git, and one file cannot spread over forks. Each test
// runs in its own async scope, so a console or log spy sees only the calls its own test caused, never a neighbour's.
// Concurrent tests share one event loop, where every git spawn is a synchronous CreateProcess on Windows, so one test's wall
// time grows with its neighbours'. WAIT caps an until() that passes the moment its condition holds; it costs nothing on a pass.
// The git-heavy batch tests can exceed 60 s under that contention, so the per-test bound leaves headroom rather than failing them.
vi.setConfig({ maxConcurrency: 8, testTimeout: 120_000 });
const WAIT = 45_000;
const spyScope = new AsyncLocalStorage<Map<object, Map<string, Mock>>>();
const routed = new WeakMap<object, Set<string>>();
const it = (name: string, fn: () => void | Promise<void>, timeout?: number) => vitestIt(name, () => spyScope.run(new Map(), fn), timeout);

/** vi.spyOn for a shared object (console, log) that records and silences only the calls made from the calling test. */
function scopedSpy<T extends object>(target: T, method: keyof T & string): Mock {
  const scope = spyScope.getStore();
  if (!scope) throw new Error('scopedSpy outside a test');
  const names = routed.get(target) ?? new Set<string>();
  routed.set(target, names);
  if (!names.has(method)) {
    names.add(method);
    const original = target[method] as (...args: unknown[]) => unknown;
    (target as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
      const spy = spyScope.getStore()?.get(target)?.get(method);
      return (spy ?? original).apply(this, args);
    };
  }
  const spy = vi.fn();
  const own = scope.get(target) ?? new Map<string, Mock>();
  scope.set(target, own);
  own.set(method, spy);
  spy.mockRestore = () => { own.delete(method); };
  return spy;
}

const LOG_DIR =path.join(os.tmpdir(), 'overseer-test-sessions'); // the fake adapter never writes there

/** Emits one Claude auth-failure turn: the structured `auth_failed` event, its result `error`, and the 401 `turn_end`. */
function emitAuthTurn(x: ReturnType<typeof setup>, sid: string, nativeSessionId = 'n1'): void {
  const h = x.sessions.handleOf(sid)!;
  x.fake.emit(h, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.', error: 'authentication_failed' });
  x.fake.emit(h, { type: 'error', message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' });
  x.fake.emit(h, { type: 'turn_end', nativeSessionId, cost: 0, authFailed: true });
}

/**
 * A claude stand-in that reports the id it chose at spawn, the way the real adapter exposes its `--session-id` on the handle:
 * a first turn rejected on its login can end without a `turn_end` and still be resumed by that id. codex and opencode report
 * one only at turn end, so their fakes keep the plain `FakeAdapter` and report none.
 */
class SpawnNativeIdFake extends FakeAdapter {
  override start(o: StartOpts): SessionHandle { return { ...super.start(o), nativeId: o.resumeId ?? 'spawn-native' }; }
}

/** An OAuth token endpoint that answers every request with `status`/`body`, recording the requests it received. */
async function tokenServer(status: number, body: string) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, requests, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

/** Points the standard tier at one claude candidate on `account`. */
function claudeStandardAccount(x: ReturnType<typeof setup>, account: string): void {
  const tiers = structuredClone(x.db.settings.tiers());
  for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account }];
  x.db.settings.set('tiers', tiers);
}

/** Points the critic tier at one claude candidate on `account`. */
function claudeCriticAccount(x: ReturnType<typeof setup>, account: string): void {
  const tiers = structuredClone(x.db.settings.tiers());
  for (const tier of tiers.tiers) if (tier.name === 'critic') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account }];
  x.db.settings.set('tiers', tiers);
}

function setup(verify: string | null = `node -e "process.exit(0)"`, workerLimit = 3, opts: { mergeMode?: Repo['merge_mode']; provider?: GitProvider; reviewRounds?: number; usageGate?: typeof accountUsable; reapEnded?: LifecycleDeps['reapEnded']; verifyRunner?: LifecycleDeps['verifyRunner']; claudeAdapter?: ClaudeAdapter; prices?: PriceCatalog; reviewCommandTimeoutMs?: number; dbPath?: string; opencodeLoginReaches?: LifecycleDeps['opencodeLoginReaches']; description?: string; pushBase?: LifecycleDeps['pushBase'] } = {}) {
  const t = mkTmpRepo();
  const db = openDb(opts.dbPath ?? ':memory:', { batchIdSuffix: () => '' }); // fixed ids (r1-b1) keep the assertions readable; the random part is db.test's
  const bus = new Bus();
  const fake = new SpawnNativeIdFake();
  const codex = new FakeAdapter('codex'); // a second fake under the codex name, so a tier that resolves to codex can start
  const opencode = new FakeAdapter('opencode'); // and one under the opencode name, so a tier that names the opencode harness can start and for the harness that hung
  const sessions = new SessionManager(db, { claude: opts.claudeAdapter ?? fake, codex, opencode }, bus, path.join(path.dirname(t.worktreesDir), 'sessions'), opts.prices);
  const store = new MemoryTaskStore();
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: verify, setup_command: null, merge_mode: opts.mergeMode ?? 'local-merge', batch_approver: 'user', worker_limit: workerLimit, review_rounds: opts.reviewRounds ?? 0, model_filter: null }; // no review round unless a test asks: the tests above assert the landing itself
  db.repos.insert(repo);
  store.add(repo.path, { id: 'ov-1', title: 'Add greeting', description: opts.description ?? 'Write hello.txt' });
  const notes: string[] = [];
  const wakes: string[] = []; // notices sent with { wake: true }: they start the orchestrator when no session is live
  const hints: (string | undefined)[] = []; // guidance for the model that travels with a notice but not into the thread row
  const storedAttachments: { name: string; mime: string; size: number; path: string }[][] = [];
  const config = { ...loadConfig({}), worktreesDir: t.worktreesDir, dataDir: path.dirname(t.worktreesDir), orchestratorDir: path.join(path.dirname(t.worktreesDir), 'orchestrator') };
  const lc = new Lifecycle({ db, store, sessions, bus, config, doctorRunner: async () => ({ code: 0, stdout: 'claude 2.1.0', stderr: '' }), usageGate: opts.usageGate ?? (async () => ({ usable: true })), reapEnded: opts.reapEnded ?? (async () => []), verifyRunner: opts.verifyRunner, provider: () => opts.provider ?? new LocalMergeProvider(), refreshRetryMs: 0, reviewCommandTimeoutMs: opts.reviewCommandTimeoutMs, prices: opts.prices, opencodeLoginReaches: opts.opencodeLoginReaches, pushBase: opts.pushBase, notify: async (m, o) => { notes.push(m); hints.push(o?.hint); storedAttachments.push(o?.storedAttachments ?? []); if (o?.wake) wakes.push(m); } });
  const phase = async (id = 'ov-1') => phaseOf((await store.show(repo.path, id))!);
  const status = async (id = 'ov-1') => (await store.show(repo.path, id))!.status;
  const finishTurn = (sid: string) => fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
  return { db, bus, fake, codex, opencode, sessions, store, repo, root: t.root, lc, config, notes, wakes, hints, storedAttachments, phase, status, finishTurn, worktreesDir: t.worktreesDir };
}

function endWorker(x: ReturnType<typeof setup>, sid: string, text: string): void {
  const session = x.db.sessions.get(sid)!;
  const handle = x.sessions.handleOf(sid)!;
  const adapter = session.harness === 'codex' ? x.codex : session.harness === 'opencode' ? x.opencode : x.fake;
  adapter.emit(handle, { type: 'assistant_text', text });
  adapter.emit(handle, { type: 'turn_end', nativeSessionId: 'evidence-worker', cost: 0.1 });
}

async function addBareOrigin(repoPath: string): Promise<string> {
  const origin = path.join(path.dirname(repoPath), 'origin.git');
  await shAsync(repoPath, ['clone', '-q', '--bare', repoPath, origin]);
  await shAsync(repoPath, ['remote', 'add', 'origin', origin]);
  return origin;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertTemporaryPushPaths(...paths: string[]): void {
  const liveData = path.join(os.homedir(), '.overseer');
  for (const p of paths) {
    expect(isWithin(os.tmpdir(), p), `${p} must be under the OS temp directory`).toBe(true);
    expect(isWithin(liveData, p), `${p} must be outside ~/.overseer`).toBe(false);
    expect(isWithin(process.cwd(), p), `${p} must be outside the checked-out repository`).toBe(false);
  }
}

async function createReviewedBatch(x: ReturnType<typeof setup>, title: string, file: string, lifecycle: Lifecycle = x.lc) {
  const batch = await lifecycle.createBatch('r1', title);
  const worktree = batchWorktreePath(x.worktreesDir, x.repo.id, batch.id);
  await commitFileAsync(worktree, file, `${title}\n`, `add ${file}`);
  x.db.batches.update(batch.id, { status: 'review' });
  return batch;
}

/**
 * A LocalMergeProvider whose `landBatch` waits on a gate, so a test can hold a Merge in flight: `entered` settles once the
 * merge reached the provider with the per-batch guard already held, and `open()` lets the real merge (or a conflict) run.
 */
function gatedMerge(conflict = false) {
  const local = new LocalMergeProvider();
  let open!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const entered = new Promise<void>((r) => { reached = r; });
  const provider: GitProvider = {
    land: (repo, wt, mr) => local.land(repo, wt, mr),
    async landBatch(repo, batch, wtPath, mr) {
      reached();
      await gate;
      return conflict ? { ok: false, conflicts: ['README.md'] } : local.landBatch(repo, batch, wtPath, mr);
    },
  };
  return { provider, entered, open };
}

/** Holds a lifecycle's retrospective until open(): the point a terminal batch action reaches after it changed its state. */
function holdRetrospective(lc: Lifecycle) {
  const real = lc.retrospective.bind(lc);
  let open!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const entered = new Promise<void>((r) => { reached = r; });
  const spy = vi.spyOn(lc, 'retrospective').mockImplementationOnce(async (id) => { reached(); await gate; return real(id); });
  return { entered, open, restore: () => spy.mockRestore() };
}

/** One bead dispatched and landed on its batch branch, the batch then in review: the state every terminal batch action starts from. */
async function batchInReview(x: ReturnType<typeof setup>) {
  await x.lc.createBatch('r1', 'Race');
  const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
  await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
  x.finishTurn(sid);
  await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
  await x.lc.requestBatchReview('r1', 'r1-b1', 'note');
}

/** One completed bead on an open batch, ready for its first review request. */
async function batchReadyForReview(x: ReturnType<typeof setup>, title = 'Ready for review') {
  const batch = await x.lc.createBatch('r1', title);
  const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: batch.id });
  await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
  x.finishTurn(sid);
  await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
  return batch;
}

describe.concurrent('Lifecycle', () => {
  const expectedBatchMilestone = (kind: 'review_ready' | 'merged', batchId: string) => ({
    kind, repo_id: 'r1', batch_id: batchId, bead_id: null, at: expect.any(String),
  });

  it('runs the happy path: spawn → commit → verify → review → request → merge', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(await x.status()).toBe('in_progress');
    const wt = x.db.worktrees.get('ov-1')!;
    expect(fs.existsSync(wt.path)).toBe(true);
    const prompt = x.fake.sent(x.sessions.handleOf(sid)!)[0]!;
    expect(prompt).toContain('Add greeting');
    expect(prompt).toContain('bead/ov-1');
    expect(x.db.sessions.get(sid)?.start_commit).toBe(await shAsync(wt.path, ['rev-parse', 'HEAD']));
    await expect(x.lc.merge('ov-1')).rejects.toBeInstanceOf(LifecycleError);

    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ verify_status: 'pass' });
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);

    await x.lc.requestMerge('r1', 'ov-1', 'Adds hello.txt as requested');
    expect(x.db.worktrees.get('ov-1')?.review_note).toBe('Adds hello.txt as requested');
    await x.lc.merge('ov-1');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(fs.existsSync(path.join(x.repo.path, 'hello.txt'))).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.db.worktrees.get('ov-1')?.merged_at).toBeTruthy();
  });

  it('batches: records a local merge before pushing the base to origin, without pushing the batch branch', async () => {
    const x = setup();
    const bare = path.join(x.root, 'origin.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    assertTemporaryPushPaths(x.root, bare, x.worktreesDir);
    const batch = await createReviewedBatch(x, 'Push base', 'pushed.txt');

    await x.lc.mergeBatch(batch.id);
    expect(x.db.batches.get(batch.id)).toMatchObject({ status: 'merged', merged_commit: expect.any(String) });
    const mergedCommit = x.db.batches.get(batch.id)!.merged_commit!;
    await until(async () => (await shAsync(bare, ['rev-parse', 'refs/heads/main'])) === mergedCommit, WAIT, 'base pushed to origin');
    expect(await shAsync(bare, ['branch', '--list', batch.branch])).toBe('');
    expect(await shAsync(x.repo.path, ['config', '--get', 'branch.main.remote']).catch(() => null)).toBeNull();
  });

  it('batches: uses the base branch upstream remote before origin', async () => {
    const x = setup();
    const origin = path.join(x.root, 'origin.git');
    const upstream = path.join(x.root, 'team.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, origin]);
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, upstream]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', origin]);
    await shAsync(x.repo.path, ['remote', 'add', 'team', upstream]);
    await shAsync(x.repo.path, ['fetch', 'team', 'main']);
    await shAsync(x.repo.path, ['branch', '--set-upstream-to=team/main', 'main']);
    assertTemporaryPushPaths(x.root, origin, upstream, x.worktreesDir);
    const originHead = await shAsync(origin, ['rev-parse', 'refs/heads/main']);
    const batch = await createReviewedBatch(x, 'Push upstream', 'upstream.txt');

    await x.lc.mergeBatch(batch.id);
    const mergedCommit = x.db.batches.get(batch.id)!.merged_commit!;
    await until(async () => (await shAsync(upstream, ['rev-parse', 'refs/heads/main'])) === mergedCommit, WAIT, 'base pushed to configured upstream');
    expect(await shAsync(origin, ['rev-parse', 'refs/heads/main'])).toBe(originHead);
  });

  it('batches: skips a base push when no remote is configured', async () => {
    let finish!: (remote: string | null) => void;
    const pushed = new Promise<string | null>((resolve) => { finish = resolve; });
    const pushBase: LifecycleDeps['pushBase'] = async (repoPath, base) => {
      const remote = await pushBaseBranch(repoPath, base);
      finish(remote);
      return remote;
    };
    const x = setup(undefined, 3, { pushBase });
    assertTemporaryPushPaths(x.root, x.worktreesDir);
    const batch = await createReviewedBatch(x, 'No remote', 'no-remote.txt');

    await x.lc.mergeBatch(batch.id);
    expect(x.db.batches.get(batch.id)?.status).toBe('merged');
    await expect(pushed).resolves.toBeNull();
    expect(x.notes.filter((note) => note.startsWith('Base push for '))).toEqual([]);
  });

  it('batches: keeps a rejected push merged and the next merge pushes its earlier commits', async () => {
    const x = setup();
    const bare = await addBareOrigin(x.repo.path);
    const other = path.join(x.root, 'remote-checkout');
    await shAsync(x.repo.path, ['clone', '-q', bare, other]);
    await commitFileAsync(other, 'remote.txt', 'remote change\n', 'remote change');
    const remoteCommit = await shAsync(other, ['rev-parse', 'HEAD']);
    await shAsync(other, ['push', 'origin', 'main']);
    assertTemporaryPushPaths(x.root, bare, other, x.worktreesDir);
    const warn = scopedSpy(console, 'warn').mockImplementation(() => {});
    let first: Awaited<ReturnType<typeof createReviewedBatch>>;
    try {
      first = await createReviewedBatch(x, 'First local merge', 'first.txt');
      expect(warn.mock.calls[0]?.[0]).toMatch(/origin\/main has 1 commit that the local main lacks/);
    } finally {
      warn.mockRestore();
    }

    await x.lc.mergeBatch(first.id);
    await until(() => x.notes.some((note) => note.startsWith('Base push for r1 to origin failed:')), WAIT, 'rejected push notice');
    const pushNotices = x.notes.filter((note) => note.startsWith('Base push for r1 to origin failed:'));
    expect(pushNotices).toHaveLength(1);
    expect(pushNotices[0]).toMatch(/! \[rejected\]\s+main -> main/);
    expect(pushNotices[0]).toContain('Run `git push origin main`');
    expect(pushNotices[0]).toContain(x.repo.path);
    expect(x.db.batches.get(first.id)).toMatchObject({ status: 'merged', merged_commit: expect.any(String) });
    const firstMerge = x.db.batches.get(first.id)!.merged_commit!;
    expect(await shAsync(bare, ['rev-parse', 'refs/heads/main'])).toBe(remoteCommit);

    x.lc.stopPendingBasePushes();
    const restarted = new Lifecycle({
      db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: x.config,
      provider: () => new LocalMergeProvider(x.worktreesDir),
      notify: async (message, options) => { x.notes.push(message); if (options?.wake) x.wakes.push(message); },
    });
    await shAsync(x.repo.path, ['fetch', 'origin', 'main']);
    await shAsync(x.repo.path, ['merge', '--no-edit', 'origin/main']);
    const second = await createReviewedBatch(x, 'Second local merge', 'second.txt', restarted);
    await restarted.mergeBatch(second.id);
    const finalBase = await shAsync(x.repo.path, ['rev-parse', 'main']);
    await until(async () => (await shAsync(bare, ['rev-parse', 'refs/heads/main'])) === finalBase, WAIT, 'later merge pushes the complete base');
    await shAsync(bare, ['merge-base', '--is-ancestor', firstMerge, finalBase]);
    await shAsync(bare, ['merge-base', '--is-ancestor', remoteCommit, finalBase]);
    expect(x.db.batches.get(second.id)?.status).toBe('merged');
    expect(x.notes.filter((note) => note.startsWith('Base push for r1 to origin failed:'))).toHaveLength(1);
  });

  it('batches: does not push the base for a gitlab-mr merge', async () => {
    const pushBase = vi.fn(async () => 'origin');
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', pushBase });
    const bare = path.join(x.root, 'origin.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    assertTemporaryPushPaths(x.root, bare, x.worktreesDir);
    const remoteHead = await shAsync(bare, ['rev-parse', 'refs/heads/main']);
    const batch = await createReviewedBatch(x, 'GitLab mark merged', 'gitlab.txt');

    await x.lc.mergeBatch(batch.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(x.db.batches.get(batch.id)).toMatchObject({ status: 'merged', merged_commit: null });
    expect(await shAsync(bare, ['rev-parse', 'refs/heads/main'])).toBe(remoteHead);
    expect(pushBase).not.toHaveBeenCalled();
  });

  it('batches: a stop cancels a queued base push without undoing the merge', async () => {
    const pushBase = vi.fn(async () => 'origin');
    const x = setup(undefined, 3, { pushBase });
    const batch = await createReviewedBatch(x, 'Stopped base push', 'stopped.txt');

    await x.lc.mergeBatch(batch.id);
    x.lc.stopPendingBasePushes();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(x.db.batches.get(batch.id)?.status).toBe('merged');
    expect(pushBase).not.toHaveBeenCalled();
  });

  it('batches: a slow base push does not hold the merge request open', async () => {
    let entered!: () => void;
    let open!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let finished = false;
    const pushBase: LifecycleDeps['pushBase'] = async () => { entered(); await gate; finished = true; return 'origin'; };
    const x = setup(undefined, 3, { pushBase });
    const batch = await createReviewedBatch(x, 'Slow base push', 'slow.txt');

    await x.lc.mergeBatch(batch.id);
    expect(x.db.batches.get(batch.id)?.status).toBe('merged');
    await started;
    expect(finished).toBe(false);
    open();
    await until(() => finished, WAIT, 'base push completion');
  });

  it('idle-end sweep ends a worker idling after its final message, and it verifies and lands like a normal end', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    // A message queued mid-turn (as `message_worker` would) means this turn end alone does not close the session: it is
    // decremented, not acted on, so the worker is left idling on its own final report exactly as acme-portal-sample-039 was.
    await x.sessions.send(sid, 'still there?');
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Final report: done.' });
    x.finishTurn(sid);
    await until(() => x.sessions.isLive(sid), WAIT, 'session stays live after its queued turn end');
    // The sweep skips a turn end younger than idleEndMs, and the clock has millisecond resolution.
    await until(() => { const last = x.db.events.last(sid); return last?.type === 'turn_end' && Date.now() - Date.parse(last.ts) >= 1; }, WAIT, 'turn end older than the idle threshold');
    await sweepIdleEnds({ db: x.db, idleEndMs: 1, end: (id) => x.sessions.end(id) });
    await until(async () => (await x.phase()) === 'review', WAIT, 'review after idle end');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ verify_status: 'pass' });
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
  });

  it('publishes the office feed the verify transitions: running before the command, then its result', async () => {
    const x = setup(`node -e "process.exit(0)"`);
    const seen: { bead_id: string; status: string }[] = [];
    x.bus.on('bead:verify', (e) => seen.push(e));
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => seen.some((e) => e.status !== 'running'), 45_000, 'verify result');
    expect(seen[0]).toEqual({ bead_id: 'ov-1', status: 'running' });
    expect(seen.at(-1)).toEqual({ bead_id: 'ov-1', status: 'pass' });
  });

  it('emits one verify-passed milestone before the final printer event with the repo, batch and bead ids', async () => {
    const x = setup();
    const events: ({ type: 'milestone'; kind: string; repo_id: string; batch_id: string | null; bead_id: string | null; at: string } | { type: 'verify'; status: string })[] = [];
    x.bus.on('office_milestone', (milestone) => events.push({ type: 'milestone', ...milestone }));
    x.bus.on('bead:verify', (event) => events.push({ type: 'verify', status: event.status }));
    const batch = await x.lc.createBatch('r1', 'Milestone');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: batch.id });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => events.some((event) => event.type === 'verify' && event.status === 'pass'), WAIT, 'terminal verify event');
    expect(events).toEqual([
      { type: 'verify', status: 'running' },
      {
        type: 'milestone', kind: 'verify_passed', repo_id: 'r1', batch_id: batch.id, bead_id: 'ov-1',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
      { type: 'verify', status: 'pass' },
    ]);
  });

  it('emits one verify-failed milestone with a null batch id for a bead without a batch', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    const milestones: unknown[] = [];
    const verifies: string[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));
    x.bus.on('bead:verify', (event) => verifies.push(event.status));
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => verifies.includes('fail'), WAIT, 'terminal verify event');
    expect(milestones).toEqual([expect.objectContaining({ kind: 'verify_failed', repo_id: 'r1', batch_id: null, bead_id: 'ov-1', at: expect.any(String) })]);
  });

  it('does not emit a verify milestone when no command is configured', async () => {
    const x = setup(null);
    const milestones: unknown[] = [];
    const verifies: string[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));
    x.bus.on('bead:verify', (event) => verifies.push(event.status));
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => verifies.includes('pass'), WAIT, 'terminal verify event');
    expect(milestones).toEqual([]);
  });

  it('does not emit a verify milestone when the runner throws before returning a result', async () => {
    const x = setup(`node -e "process.exit(0)"`, 3, { verifyRunner: async () => { throw new Error('runner failed'); } });
    const milestones: unknown[] = [];
    const verifies: string[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));
    x.bus.on('bead:verify', (event) => verifies.push(event.status));
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => verifies.includes('fail'), WAIT, 'terminal verify event');
    expect(milestones).toEqual([]);
  });

  it('leaves the office feed printer even when the verification cannot be recorded (a bd failure must not strand the character)', async () => {
    const x = setup(`node -e "process.exit(0)"`);
    const seen: { bead_id: string; status: string }[] = [];
    x.bus.on('bead:verify', (e) => seen.push(e));
    const originalUpdate = x.store.update.bind(x.store);
    const update = vi.spyOn(x.store, 'update').mockImplementation(async (repoPath, id, patch) => {
      if (patch.phase === 'review') throw new Error('database is locked');
      return originalUpdate(repoPath, id, patch);
    });
    scopedSpy(console, 'error'); // the reopen this failure causes is logged by design
    try {
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
      x.finishTurn(sid);
      await until(() => seen.some((e) => e.status !== 'running'), 45_000, 'terminal verify event');
      expect(seen.map((e) => e.status)).toEqual(['running', 'pass']);
    } finally {
      update.mockRestore();
    }
  });

  it('fails and reopens when the worker ends without commits', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'I could not do it' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('I could not do it');
    expect(x.notes).toEqual(['ov-1 reopened: worker ended without commits on claude: I could not do it']);
    expect(x.wakes).toEqual(x.notes); // a reopened bead needs the orchestrator, session or not
    await expect(x.lc.reverify('ov-1')).rejects.toThrow(/no commits to verify/); // nothing on the branch to verify
  });

  it('re-dispatches at once when a no-commit worker says the work is still running elsewhere', async () => {
    const x = setup();
    const prior = 'Use the auth helper in src/auth.';
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', instructions: prior });
    const sentence = 'I have handed the implementation off to a background agent, which will commit it when it finishes.';
    x.fake.emit(x.sessions.handleOf(first)!, { type: 'assistant_text', text: `Here is where things stand. ${sentence}` });
    x.finishTurn(first);
    await until(async () => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'deferred re-dispatch');
    const second = x.db.sessions.forBead('ov-1')[1]!;
    expect(x.db.sessions.get(first)?.status).toBe('failed');
    expect(second.harness).not.toBe('claude'); // a harness the bead has not just failed on
    const prompt = x.codex.sent(x.sessions.handleOf(second.id)!)[0]!;
    expect(prompt).toContain('commit it on this branch in this session'); // the work must be done and committed in the new session
    expect(prompt).toContain(prior); // the orchestrator's own instructions survive the automatic re-dispatch
    expect(prompt).toContain(sentence);
    await until(() => x.notes.some((n) => n.includes('still running elsewhere')), WAIT, 'deferred notice');
    expect(x.notes.at(-1)).toContain(`re-dispatched to codex`);
    expect(x.notes.at(-1)).toContain(`reported the work as still running elsewhere ("${sentence}")`);
    const beadNotes = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect(beadNotes).toContain(`ended without new commits, reporting the work as still running elsewhere ("${sentence}")`);
  });

  it('keeps the ordinary no-commit reopen when the message reports finished work with a check still running', async () => {
    // The finished-work clause covers the variants that would otherwise read as a hand-off: a gerund check, and a check run by
    // a sub-agent with no "background" wording at all.
    const texts = [
      'I have committed the change and a background agent is running the checks.',
      "I've finished and a background agent is checking it",
      'I committed the change and a sub-agent is running the tests',
    ];
    for (const text of texts) {
      const x = setup();
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text });
      x.finishTurn(sid);
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      expect(x.db.sessions.forBead('ov-1'), text).toHaveLength(1); // no re-dispatch: a false positive would send the bead round again
      expect(x.db.sessions.get(sid)?.status).toBe('failed');
      expect(x.notes).toEqual([`ov-1 reopened: worker ended without commits on claude: ${text}`]);
    }
  });

  it('closes a verify_only bead as worker-reported when every reported check passes', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    expect(x.db.sessions.get(sid)?.verify_only).toBe(1);
    const wt = x.db.worktrees.get('ov-1')!;
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'verified notice'); // the notice is the last step of the settle, after the close and the worktree removal
    const bead = await x.store.show(x.repo.path, 'ov-1');
    expect({ status: bead?.status, phase: await x.phase(), labels: bead?.labels, notes: bead?.notes, notice: x.notes[0] }).toMatchObject({
      status: 'closed',
      phase: 'worker-reported',
      labels: expect.arrayContaining(['overseer:worker-reported']),
      notes: expect.stringContaining('closed: worker-reported result, no commits'),
      notice: 'ov-1 closed as worker-reported: the worker reported its result and committed nothing.',
    });
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    const notes = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect(notes).toContain(`Worker-reported result from session ${sid} (no commits):
Check: pnpm test - PASS - Tests 5 passed (5)`);
    expect(x.db.worktrees.get('ov-1')?.closed_at).toBeTruthy();
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.wakes).toEqual(x.notes);
    expect(x.hints[0]).toContain("Its result is in the bead's notes");
  });

  it('runs a configured verify_command and stores the command, head, exit code and parsed counts', async () => {
    const x = setup();
    const command = `node -e "console.log('Tests 5 passed | 2 skipped | 1 todo (8)')"`;
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    const wt = x.db.worktrees.get('ov-1')!;
    const head = await shAsync(wt.path, ['rev-parse', 'HEAD']);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'The configured verification command was ready to run.' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'verified notice');
    expect({ status: await x.status(), phase: await x.phase(), worktree: x.db.worktrees.get('ov-1') }).toMatchObject({
      status: 'closed',
      phase: 'verified',
      worktree: { verify_command: command, verify_only_result: { status: 'pass', command, head_sha: head, exit_code: 0, counts: { passed: 5, failed: 0, skipped: 2, todo: 1, flaky: 0 } } },
    });
  });

  it('Board re-dispatch keeps and runs the saved verify_command', async () => {
    const x = setup();
    const command = `node -e "console.log('Tests 4 passed (4)')"`;
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.status()) === 'open', WAIT, 'first verify-only attempt reopens');
    const second = await x.lc.redispatch('ov-1');
    x.fake.emit(x.sessions.handleOf(second)!, { type: 'turn_end', nativeSessionId: 'board-retry', cost: 0 });
    await until(async () => x.db.worktrees.get('ov-1')?.verify_only_result?.status === 'pass' && await x.phase() === 'verified', WAIT, 'saved command closes as verified');
    const worktree = x.db.worktrees.get('ov-1')!;
    expect({ first: x.db.sessions.get(first)?.status, verifyOnly: x.db.sessions.get(second)?.verify_only, command: worktree.verify_command, result: worktree.verify_only_result, phase: await x.phase() }).toMatchObject({
      first: 'ended', verifyOnly: 1, command, result: { status: 'pass', command, exit_code: 0 }, phase: 'verified',
    });
  });

  it('a verify-only re-dispatch with a new verify_command replaces the saved command', async () => {
    const x = setup();
    const command = `node -e "process.exit(0)"`;
    const replacement = `node -e "process.exit(2)"`;
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.status()) === 'open', WAIT, 'first attempt reopens');
    const second = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: replacement });
    expect(x.db.worktrees.get('ov-1')?.verify_command).toBe(replacement);
    await x.lc.interruptBead('ov-1');
    expect(x.db.sessions.get(second)?.verify_only).toBe(1);
  });

  it('a dispatch without verify_only clears the saved verify_command', async () => {
    const x = setup();
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: `node -e "process.exit(0)"` });
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.status()) === 'open', WAIT, 'first attempt reopens');
    const second = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.worktrees.get('ov-1')?.verify_command).toBeNull();
    await x.lc.interruptBead('ov-1');
    expect(x.db.sessions.get(second)?.verify_only).toBe(0);
  });

  it('re-adoption after a daemon restart verifies from the saved worktree row', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-verify-adopt-'));
    const dbPath = path.join(tempDir, 'daemon.sqlite');
    const x = setup(undefined, 3, { dbPath });
    const command = `node -e "console.log('Tests 7 passed (7)')"`;
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    const logFile = path.join(tempDir, 'worker.log');
    const child = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
    let restartedDb: ReturnType<typeof openDb> | null = null;
    let originalClosed = false;
    try {
      x.db.sessions.update(sid, { pid: child.pid!, pid_started_at: await processStartTime(child.pid!), log_path: logFile, log_offset: 0 });
      x.db.sql.close();
      originalClosed = true;
      const db = openDb(dbPath, { batchIdSuffix: () => '' });
      restartedDb = db;
      const bus = new Bus();
      const sessions = new SessionManager(db, { claude: x.fake }, bus, path.join(tempDir, 'sessions'));
      const restarted = new Lifecycle({ db, store: x.store, sessions, bus, config: x.config, provider: () => new LocalMergeProvider(), notify: async (message) => { x.notes.push(message); }, reapEnded: async () => [] });
      await restarted.recover();
      const adopted = sessions.isLive(sid);
      x.fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'adopted-worker', cost: 0 });
      await until(async () => db.worktrees.get('ov-1')?.verify_only_result?.status === 'pass' && await x.phase() === 'verified', WAIT, 'adopted worker closes as verified');
      const worktree = db.worktrees.get('ov-1')!;
      expect({ adopted, command: worktree.verify_command, result: worktree.verify_only_result, phase: await x.phase() }).toMatchObject({
        adopted: true, command, result: { status: 'pass', command, exit_code: 0 }, phase: 'verified',
      });
    } finally {
      await killProcess(child.pid!).catch(() => {});
      if (restartedDb) restartedDb.sql.close();
      else if (!originalClosed) x.db.sql.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reopens when verify_command fails even if every Check line reports PASS', async () => {
    const x = setup();
    const command = `node -e "console.log('Tests 5 passed (5)'); process.exit(7)"`;
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    const wt = x.db.worktrees.get('ov-1')!;
    const head = await shAsync(wt.path, ['rev-parse', 'HEAD']);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: `Check: ${command} - PASS - Tests 5 passed (5)` });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && x.notes.length > 0, WAIT, 'verify command failure reopen');
    const note = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect({ phase: await x.phase(), result: x.db.worktrees.get('ov-1')?.verify_only_result, note, notice: x.notes[0] }).toMatchObject({
      phase: null,
      result: { status: 'fail', command, head_sha: head, exit_code: 7, counts: { passed: 5, failed: 0, skipped: 0, todo: 0, flaky: 0 } },
      note: expect.stringContaining(`Worker-reported PASS for the same command:\n> Check: ${command} - PASS - Tests 5 passed (5)`),
      notice: expect.stringContaining('daemon verify command'),
    });
    expect(note).toContain('> exit 7');
  });

  it('closes a verify_only bead as worker-reported despite an earlier recoverable error in the session', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'error', message: 'event stream failed: socket hang up' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'verified notice');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('worker-reported');
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    expect(x.notes).toEqual(['ov-1 closed as worker-reported: the worker reported its result and committed nothing.']);
  });

  it('reopens a verify_only bead when any reported check is not PASS', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: [
      'Check: pnpm test - PASS - Tests 5 passed (5)',
      'Check: pnpm typecheck - FAIL - one error',
    ].join('\n') });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'verify incomplete reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Verification incomplete: the following Check: lines did not PASS:\n> Check: pnpm typecheck - FAIL - one error');
    expect(x.notes).toEqual(['ov-1 reopened: verification-only result is incomplete; the following Check: lines did not PASS:\n> Check: pnpm typecheck - FAIL - one error']);
    expect(x.wakes).toEqual(x.notes);
    expect(x.hints[0]).toContain('Re-dispatch');
  });

  it('reopens a verify_only bead when its final message has no Check line', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: "I'll wait for its reply" });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'verify incomplete reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Verification incomplete: no Check: lines were reported.');
    expect(x.notes).toEqual(['ov-1 reopened: verification-only result is incomplete; no Check: lines were reported.']);
    expect(x.wakes).toEqual(x.notes);
    expect(x.hints[0]).toContain('Re-dispatch');
  });

  it('lets a stop win over an opted-in verify-only evidence failure', async () => {
    const x = setup(undefined, 3, { description: 'Run checks\nParity widths: 390' });
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.status()) === 'open', WAIT, 'stopped verify-only bead reopened');

    expect(x.notes).toEqual(['ov-1 stopped by the user from the Board; reopened without new commits.']);
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).not.toContain('Evidence gate:');
  });

  it('counts a worker-reported bead as closed for its batch, so request_batch_review is not refused', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Hotfix');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1', verifyOnly: true });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'verified notice'); // the notice is the last step of the settle, after the close and the worktree removal
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('worker-reported');
    expect(x.notes).toEqual(['ov-1 closed as worker-reported: the worker reported its result and committed nothing; batch r1-b1 stays open (0/1 beads done, 1 closed).']);
    expect(x.hints[0]).toContain('call request_batch_review');
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[0]).toMatchObject({ id: 'r1-b1', beads_total: 1, beads_done: 0, beads_closed: 1 });
    const card = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(card).toMatchObject({ column: 'done', state: 'done', batch_id: 'r1-b1' });
    expect(card.bead.labels).toContain('overseer:worker-reported');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'All checks recorded');
    expect(x.db.batches.get('r1-b1')?.status).toBe('review');
  });

  it('reopens a verify_only bead as verify_incomplete when its worker reports no final text', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Verification incomplete: no Check: lines were reported.');
    expect(x.notes).toEqual(['ov-1 reopened: verification-only result is incomplete; no Check: lines were reported.']);
  });

  it('reopens a worker that died at startup with the first stderr lines next to its exit code', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', "\nerror: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS]\n");
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 2' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      const expected = "codex exited with code 2: error: unexpected argument '--full-auto' found; Usage: codex exec [OPTIONS]";
      expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain(`ended without new commits: ${expected}`);
      expect(x.notes).toEqual([`ov-1 reopened: worker ended without commits on codex: ${expected}`]);
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('keeps the crash path when a verify_only worker dies at startup', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex', verifyOnly: true });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', "error: unexpected argument '--full-auto' found\nUsage: codex exec [OPTIONS]\n");
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 2' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      const expected = "codex exited with code 2: error: unexpected argument '--full-auto' found; Usage: codex exec [OPTIONS]";
      expect(x.db.sessions.get(sid)?.crash_class).toBe('harness_bug');
      expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain(`ended without new commits: ${expected}`);
      expect(x.notes).toEqual([`ov-1 reopened: worker ended without commits on codex: ${expected}`]);
      expect(x.hints[0]).toContain('do not re-dispatch this bead on codex');
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('still appends the stderr lines when the CLI printed a raw line before it exited at startup', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', "error: unexpected argument '--full-auto' found\n");
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'raw', line: 'codex 0.154.0' });
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 2' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      expect(x.notes).toEqual(["ov-1 reopened: worker ended without commits on codex: codex exited with code 2: error: unexpected argument '--full-auto' found"]);
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('keeps the plain exit reason for a worker that produced events before it exited', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', 'warning: something\n');
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'assistant_text', text: 'Working on it.' });
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 1' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      expect(x.notes).toEqual(['ov-1 reopened: worker ended without commits on codex: codex exited with code 1; last message: Working on it.']);
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('counts a sub-agent event as a startup event, so the stderr lines are not appended (the answer the full-session scan gave)', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', 'error: something the CLI rejected\n');
    try {
      const h = x.sessions.handleOf(sid)!;
      // A sub-agent's event carries a `parentId`; the old scan counted it and the EXISTS lookup must too.
      x.codex.emit(h, { type: 'tool_call', id: 'c1', name: 'Task', input: { prompt: 'go' }, parentId: 'call_task' });
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 1' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      expect(x.notes).toEqual(['ov-1 reopened: worker ended without commits on codex: codex exited with code 1']);
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('keeps configured order and logs that no catalog is loaded when the price catalog never loaded', async () => {
    const catalog = new PriceCatalog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-prices-')), 'missing.json'));
    expect(catalog.load()).toBe(false);
    const x = setup(undefined, undefined, { prices: catalog });
    const info = scopedSpy(log, 'info');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra' });
    expect(info.mock.calls.map((c) => String(c[0]))).toContain('lifecycle: ov-1 standard picked codex/gpt-5.6-terra in configured order: no price catalog is loaded');
  });

  it('picks the cheapest candidate from a loaded catalog and logs its price', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-prices-')), 'models.dev.json');
    fs.writeFileSync(file, JSON.stringify({ openai: { models: { 'gpt-5.6-terra': { cost: { input: 5, output: 20 } } } }, anthropic: { models: { sonnet: { cost: { input: 3, output: 15 } } } } }));
    const catalog = new PriceCatalog(file);
    expect(catalog.load()).toBe(true);
    const x = setup(undefined, undefined, { prices: catalog });
    const info = scopedSpy(log, 'info');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet' });
    expect(info.mock.calls.map((c) => String(c[0]))).toContain('lifecycle: ov-1 standard picked claude/sonnet at $3/M input (cheapest usable)');
  });

  describe('repository model filter', () => {
    const allowed: NonNullable<Repo['model_filter']> = { harnesses: ['claude'], models: ['opus'], accounts: ['P'] };
    const configure = (x: ReturnType<typeof setup>, filter: Repo['model_filter'] = allowed) => {
      for (const id of ['A', 'P']) x.db.accounts.insert({ id, name: `Account ${id}`, harness: 'claude', kind: 'oauth_token', secret: `token-${id}`, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      const standard: TierCandidate[] = [
        { harness: 'claude', model: 'opus', effort: 'high', account: 'A' },
        { harness: 'codex', model: 'gpt-6-luna', effort: null },
        { harness: 'opencode', model: 'deepseek-flash', effort: null, account: 'O' },
        { harness: 'claude', model: 'opus', effort: 'high', account: 'P' },
      ];
      for (const tier of tiers.tiers) {
        if (tier.name === 'standard') tier.candidates = standard;
        if (tier.name === 'chore') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'P' }];
        if (tier.name === 'hard') tier.candidates = standard.map((c) => c.account === 'P' ? { ...c, effort: 'max' } : c);
        if (tier.name === 'critic') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null }];
      }
      x.db.settings.set('tiers', tiers);
      x.db.repos.update('r1', { model_filter: filter });
    };

    it('refuses a harness-only codex dispatch before checking usage', async () => {
      const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: true }));
      const x = setup(undefined, 3, { usageGate }); configure(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' })).rejects.toThrow('repository r1 model filter excludes harness codex');
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode', needsServer: true })).rejects.toThrow('repository r1 model filter excludes harness opencode');
      expect(usageGate).not.toHaveBeenCalled();
      expect(x.codex.sessions.size).toBe(0);
      expect(x.db.worktrees.get('ov-1')).toBeUndefined();
    });

    it('runs a forced claude dispatch on opus at P, skipping the earlier A candidate', async () => {
      const x = setup(); configure(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', account: 'P', tier: null });
      expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'token-P' });
    });

    it('scans through filtered standard and chore candidates to the allowed hard candidate', async () => {
      const x = setup(); configure(x);
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = tier.candidates.filter((c) => c.account !== 'P');
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ model: 'opus', account: 'P' });
      expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.effort).toBe('max');
    });

    it('does not reuse a recorded account outside the filter', async () => {
      const x = setup(); configure(x, null);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      const recorded = x.db.sessions.get(first)!;
      expect(recorded.account).toBe('A');
      x.db.sessions.update(first, { status: 'ended', ended_at: new Date().toISOString() });
      x.db.repos.update('r1', { model_filter: allowed });
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: recorded.model!, account: recorded.account });
      expect(x.db.sessions.get(sid)).toMatchObject({ model: 'opus', account: 'P' });
      expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'token-P' });
    });

    it('refuses degraded fallback when no candidate passes the filter, even with a recorded account', async () => {
      const x = setup(); configure(x);
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) tier.candidates = tier.candidates.filter((c) => c.account !== 'P');
      x.db.settings.set('tiers', tiers);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: 'opus', account: 'A' })).rejects.toThrow('repository r1 model filter leaves no usable claude candidate');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
      expect(x.fake.sessions.size).toBe(0);
      expect(x.db.worktrees.get('ov-1')).toBeUndefined();
    });

    it('refuses CLI-login fallback when the allowed account has no stored authorization', async () => {
      const x = setup(); configure(x);
      x.db.accounts.update('P', { secret: null, last_login_at: null });
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow('repository r1 model filter leaves no usable claude candidate');
      x.db.accounts.remove('P');
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow('repository r1 model filter leaves no usable claude candidate');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
      expect(x.fake.sessions.size).toBe(0);
    });

    it('waits with one filter notice after the only allowed forced account reaches its usage limit', async () => {
      const x = setup(undefined, 3, { usageGate: async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true } });
      configure(x);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(), raw: {} });
      await until(() => x.wakes.length === 1, WAIT, 'filtered forced rate-limit refusal');
      const reason = 'repository r1 model filter leaves no usable claude candidate: account P exhausted';
      expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toContain(reason);
      expect(x.notes).toHaveLength(1);
      expect(x.wakes[0]).toContain(reason);
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
      expect(x.fake.sessions.size).toBe(1);
      expect(await x.status()).toBe('open');
    });

    it('reopens with the filter reason and one notice when allowed forced candidates are exhausted', async () => {
      const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => accountId === 'P' ? { usable: false, reason: 'account P exhausted' } : { usable: true });
      const x = setup(undefined, 3, { usageGate }); configure(x);
      const reason = 'repository r1 model filter leaves no usable claude candidate: account P exhausted';
      await x.store.update(x.repo.path, 'ov-1', { status: 'in_progress', phase: 'verifying' });
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow(reason);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow(reason);
      expect(await x.status()).toBe('open');
      expect(await x.phase()).toBeNull();
      expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toContain(reason);
      expect(x.notes).toEqual([reason]);
      expect(x.wakes).toEqual([reason]);
      expect(new Set(usageGate.mock.calls.map((call) => call[2]))).toEqual(new Set(['P']));
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });

    it('refuses a pinned model outside the filter before checking usage', async () => {
      const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: true }));
      const x = setup(undefined, 3, { usageGate }); configure(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: 'sonnet' })).rejects.toThrow('repository r1 model filter excludes model sonnet');
      expect(usageGate).not.toHaveBeenCalled();
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });

    it('refuses an automatic harness-only codex retry after the filter is set', async () => {
      const x = setup(); configure(x, null);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
      expect(x.db.sessions.get(first)).toMatchObject({ harness: 'codex', tier: null });
      x.db.repos.update('r1', { model_filter: allowed });
      const handle = x.sessions.handleOf(first)!;
      const error = scopedSpy(log, 'error');
      x.codex.emit(handle, { type: 'error', message: 'event stream failed: socket hang up' });
      x.codex.emit(handle, { type: 'turn_end', nativeSessionId: '' });
      await until(() => x.wakes.length === 1, WAIT, 'filtered automatic retry refusal');
      expect(error).toHaveBeenCalledWith('lifecycle: transient retry of ov-1 failed', expect.objectContaining({ message: 'repository r1 model filter excludes harness codex' }));
      expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toContain('repository r1 model filter excludes harness codex');
      expect(x.wakes[0]).toContain('repository r1 model filter excludes harness codex');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
      expect(x.codex.sessions.size).toBe(1);
      expect(await x.status()).toBe('open');
    });

    it('treats empty allowlists as unrestricted while still requiring a usable forced candidate', async () => {
      const x = setup(); configure(x, { harnesses: [], models: [], accounts: [] });
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ model: 'opus', account: 'A' });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) tier.candidates = [];
      x.db.settings.set('tiers', tiers);
      x.store.add(x.repo.path, { id: 'ov-2', title: 'Second task', description: 'Write another file' });
      await expect(x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude' })).rejects.toThrow('repository r1 model filter leaves no usable claude candidate');
      expect(x.db.sessions.forBead('ov-2')).toHaveLength(0);
    });

    it('runs standard on P even when codex is cheaper and A precedes P', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-prices-')), 'models.dev.json');
      fs.writeFileSync(file, JSON.stringify({ openai: { models: { 'gpt-6-luna': { cost: { input: 1, output: 1 } } } }, anthropic: { models: { opus: { cost: { input: 10, output: 10 } } } } }));
      const catalog = new PriceCatalog(file);
      expect(catalog.load()).toBe(true);
      const x = setup(undefined, 3, { prices: catalog });
      configure(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', account: 'P', tier: 'standard' });
    });

    it('refuses an empty chore tier without starting a session or trying another tier', async () => {
      const x = setup(); configure(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'chore' })).rejects.toThrow('repository r1 model filter excludes every candidate in tier chore');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
      expect(x.db.worktrees.get('ov-1')).toBeUndefined();
    });

    it('reopens with one usage notice when P is exhausted', async () => {
      const x = setup(undefined, 3, { usageGate: async (_db, _config, accountId) => accountId === 'P' ? { usable: false, reason: 'account P exhausted' } : { usable: true } });
      configure(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' })).rejects.toThrow('no usable account for tier standard: account P exhausted');
      expect(await x.status()).toBe('open');
      expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toContain('no usable account for tier standard: account P exhausted');
      expect(x.wakes).toEqual(['no usable account for tier standard: account P exhausted']);
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });

    it('refuses a forced codex standard tier with the filter reason', async () => {
      const x = setup(); configure(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex', tier: 'standard' })).rejects.toThrow('repository r1 model filter excludes every codex candidate in tier standard');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });

    it('steps up from standard to hard on P', async () => {
      const x = setup(); configure(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', stepUp: true });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', account: 'P' });
      expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.effort).toBe('max');
    });

    it('refuses needs_server when only opencode passes the filter', async () => {
      const x = setup(); configure(x, { harnesses: ['opencode'], models: [], accounts: [] });
      await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', needsServer: true })).rejects.toThrow(/no usable harness for tier standard: opencode cannot keep a server/);
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });

    it('reopens after a rate limit when its only allowed account is exhausted', async () => {
      const x = setup(undefined, 3, { usageGate: async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true } });
      configure(x);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(), raw: {} });
      await until(async () => (await x.status()) === 'open', WAIT, 'rate-limit reopen');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
      expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toContain('no usable account for tier standard: account P exhausted');
      expect(x.wakes).toHaveLength(1);
    });

    it('uses P on a tier-only retry after an earlier codex session', async () => {
      const x = setup(); configure(x, null);
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [tier.candidates[1]!, tier.candidates[0]!, ...tier.candidates.slice(2)];
      x.db.settings.set('tiers', tiers);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      expect(x.db.sessions.get(first)).toMatchObject({ harness: 'codex', model: 'gpt-6-luna', account: null, harness_forced: null });
      x.db.sessions.update(first, { status: 'ended', ended_at: new Date().toISOString() });
      x.db.repos.update('r1', { model_filter: allowed });
      const second = await x.lc.redispatch('ov-1');
      expect(x.db.sessions.get(second)).toMatchObject({ harness: 'claude', model: 'opus', account: 'P' });
    });

    it('keeps the critic on the global tier', async () => {
      const x = setup(undefined, 3, { reviewRounds: 1 }); configure(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      const wt = x.db.worktrees.get('ov-1')!;
      await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
      x.fake.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
      await until(() => !!x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic' && s.status === 'running'), WAIT, 'critic session');
      expect(x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic')).toMatchObject({ harness: 'claude', model: 'fable', account: null });
    });
  });

  it('re-dispatches a first transient stream failure once on the same model', async () => {
    const x = setup();
    // Without a verify_command a verify-only session that errored and reported no passing Check line reaches the transient crash retry.
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: undefined, verifyOnly: true });
    const model = x.db.sessions.get(first)!.model;
    const h = x.sessions.handleOf(first)!;
    const fakeFor = x.db.sessions.get(first)!.harness === 'codex' ? x.codex : x.fake;
    fakeFor.emit(h, { type: 'error', message: 'event stream failed: socket hang up' });
    fakeFor.emit(h, { type: 'turn_end', nativeSessionId: '' });
    await until(async () => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'retry');
    const second = x.db.sessions.forBead('ov-1')[1]!;
    expect(second).toMatchObject({ harness: x.db.sessions.get(first)!.harness, model, verify_only: 1 });
    expect(x.db.sessions.get(first)!.crash_class).toBe('transient');
    const harness = x.db.sessions.get(first)!.harness;
    expect(x.notes).toEqual([`ov-1 re-dispatched after a transient stream failure on ${harness} (event stream failed: socket hang up).`]);
    expect(x.wakes).toEqual([]);

    const h2 = x.sessions.handleOf(second.id)!;
    fakeFor.emit(h2, { type: 'error', message: 'event stream failed: socket hang up' });
    fakeFor.emit(h2, { type: 'turn_end', nativeSessionId: '' });
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(2);
    expect(x.wakes).toEqual([`ov-1 reopened: worker ended without commits on ${harness}: event stream failed: socket hang up`]);
  });

  it('never retries a harness bug and says so in the hint', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', "error: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS]\n");
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 2' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
      expect(x.db.sessions.get(sid)!.crash_class).toBe('harness_bug');
      expect(x.hints.at(-1)).toBe('The codex CLI failed to start (a harness bug, not the task): do not re-dispatch this bead on codex; pass harness claude or ask the user.');
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('classifies a worker that produced events before exiting as task, not harness_bug, even with usage text in stderr', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const logPath = x.db.sessions.get(sid)!.log_path!;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath + '.err', "error: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS]\n");
    try {
      const h = x.sessions.handleOf(sid)!;
      x.codex.emit(h, { type: 'assistant_text', text: 'Working on it.' });
      x.codex.emit(h, { type: 'error', message: 'codex exited with code 2' });
      x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
      expect(x.db.sessions.get(sid)!.crash_class).toBe('task');
      expect(x.hints.at(-1)).toBeUndefined();
    } finally {
      fs.rmSync(logPath + '.err', { force: true });
    }
  });

  it('pins a transient retry to the crashed session\'s own model, even when it was not the tier\'s top candidate', async () => {
    let terraBlocked = true;
    const x = setup(undefined, 3, { usageGate: async (_db, _config, _accountId, model) => (model === 'terra' && terraBlocked ? { usable: false, reason: 'terra busy' } : { usable: true }) });
    x.db.accounts.insert({ id: 'a1', name: 'A1', harness: 'codex', kind: 'codex_home', home: 'C:/a1', created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: 'a1' }, { harness: 'codex', model: 'sol', effort: null, account: 'a1' }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(first)!.model).toBe('sol'); // terra (the top candidate) is gated, so the first attempt lands on sol
    terraBlocked = false; // terra becomes usable again before the retry: an unpinned retry would land back on it
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'error', message: 'event stream failed: socket hang up' });
    x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
    await until(async () => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'retry');
    const second = x.db.sessions.forBead('ov-1')[1]!;
    expect(second.model).toBe('sol'); // pinned to the crashed session's own model, not the now-fresh top candidate
    expect(second.harness).toBe('codex');
    expect(x.notes).toEqual(['ov-1 re-dispatched after a transient stream failure on codex account A1 (event stream failed: socket hang up).']);
  });

  it('does not double the reopen notice when the transient retry itself is refused for usage', async () => {
    let usable = true;
    const x = setup(undefined, 3, { usageGate: async () => (usable ? { usable: true } : { usable: false, reason: 'account a1 exhausted' }) });
    x.db.accounts.insert({ id: 'a1', name: 'A1', harness: 'codex', kind: 'codex_home', home: 'C:/a1', created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: 'a1' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    usable = false; // the retry's own tier resolution is now refused for usage
    const h = x.sessions.handleOf(sid)!;
    x.codex.emit(h, { type: 'error', message: 'event stream failed: socket hang up' });
    x.codex.emit(h, { type: 'turn_end', nativeSessionId: '' });
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen after a refused retry');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1); // the refused retry created no second session
    expect(x.notes).toEqual(['ov-1 reopened: worker ended without commits on codex account A1: event stream failed: socket hang up']);
    expect(x.wakes).toEqual(x.notes);
  });

  describe('a forced opencode harness', () => {
    const opencodeTiers = (x: ReturnType<typeof setup>) => {
      for (const id of ['oc1', 'oc2']) x.db.accounts.insert({ id, name: id, harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: `key-${id}`, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) {
        if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null }, { harness: 'opencode', model: 'deepseek/flash', effort: 'high', account: 'oc1' }];
        if (tier.name === 'chore') tier.candidates = [{ harness: 'opencode', model: 'deepseek/chore', effort: null, account: 'oc2' }];
      }
      x.db.settings.set('tiers', tiers);
    };

    it('runs on the standard tier\'s first opencode model and account, and keeps a null tier', async () => {
      const x = setup();
      opencodeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'opencode', model: 'deepseek/flash', account: 'oc1', tier: null });
      const started = x.opencode.sessions.get(x.sessions.handleOf(sid)!.id)!.opts;
      expect(started).toMatchObject({ model: 'deepseek/flash', effort: 'high' });
      expect(started.env?.DEEPSEEK_API_KEY).toBe('key-oc1');
    });

    it('skips an exhausted candidate for the next usable one', async () => {
      const x = setup(undefined, 3, { usageGate: async (_db, _config, accountId) => (accountId === 'oc1' ? { usable: false, reason: 'oc1 exhausted' } : { usable: true }) });
      opencodeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' });
      expect(x.db.sessions.get(sid)).toMatchObject({ model: 'deepseek/chore', account: 'oc2', tier: null });
    });

    it('refuses while the opencode harness is held by a usage limit', async () => {
      const x = setup();
      opencodeTiers(x);
      x.db.settings.set('harness_limits', { opencode: Date.now() + 60 * 60 * 1000 });
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' })).rejects.toThrow(/^ov-1 was not dispatched: /);
      expect(x.opencode.sessions.size).toBe(0);
    });

    it('takes the tier\'s claude account for a forced claude harness, so the CLI reaches its plugin MCP servers', async () => {
      const x = setup();
      x.db.accounts.insert({ id: 'cw', name: 'Claude Work', harness: 'claude', kind: 'oauth_token', secret: 'oauth-token-value', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'cw' }];
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'cw', tier: null });
      const started = x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts;
      expect(started.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value', ANTHROPIC_API_KEY: undefined });
    });

    it('keeps the opencode default and warns when no opencode candidate is configured', async () => {
      const warn = scopedSpy(log, 'warn');
      const x = setup();
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) tier.candidates = tier.candidates.filter((c) => c.harness !== 'opencode');
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'opencode', model: null, account: null });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable opencode candidate'));
    });
  });

  describe('records the token expiry of the account a session starts on', () => {
    const claudeStandardAccount = (x: ReturnType<typeof setup>, accountId: string) => {
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: accountId }];
      x.db.settings.set('tiers', tiers);
    };
    const criticAccount = (x: ReturnType<typeof setup>, accountId: string) => {
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'critic') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account: accountId }];
      x.db.settings.set('tiers', tiers);
    };
    /** An OAuth token endpoint that mints a two-hour token, with the requests it received. */
    async function refreshServer() {
      const requests: Record<string, unknown>[] = [];
      const server = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
          requests.push(JSON.parse(raw) as Record<string, unknown>);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 7200 }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, requests, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
    }

    it('records the account token expiry a worker starts with', async () => {
      const x = setup();
      const expiry = Date.now() + 3 * 60 * 60_000;
      x.db.accounts.insert({ id: 'cw', name: 'Claude Work', harness: 'claude', kind: 'oauth_token', secret: 'oauth-token-value', refresh_token: 'refresh-cw', token_expires_at: expiry, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      claudeStandardAccount(x, 'cw');
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ account: 'cw', token_expires_at: expiry });
    });

    it('records the refreshed expiry a worker starts with, not the stale one', async () => {
      const x = setup();
      const server = await refreshServer();
      const oldTokenUrl = x.config.anthropicTokenUrl;
      x.config.anthropicTokenUrl = server.url;
      try {
        const stale = Date.now() - 1;
        x.db.accounts.insert({ id: 'cw', name: 'Claude Work', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'refresh-cw', token_expires_at: stale, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
        claudeStandardAccount(x, 'cw');
        const before = Date.now();
        const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
        const after = Date.now();
        expect(server.requests.length).toBeGreaterThanOrEqual(1);
        const recorded = x.db.sessions.get(sid)!.token_expires_at!;
        expect(recorded).not.toBe(stale);
        expect(recorded).toBeGreaterThanOrEqual(before + 7_200_000);
        expect(recorded).toBeLessThanOrEqual(after + 7_200_000);
      } finally {
        x.config.anthropicTokenUrl = oldTokenUrl;
        await server.close();
      }
    });

    it('records the account token expiry a critic starts with', async () => {
      const x = setup(undefined, 3, { reviewRounds: 2 });
      const expiry = Date.now() + 3 * 60 * 60_000;
      x.db.accounts.insert({ id: 'cc', name: 'Critic Claude', harness: 'claude', kind: 'oauth_token', secret: 'critic-access', refresh_token: 'refresh-cc', token_expires_at: expiry, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      criticAccount(x, 'cc');
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      const wt = x.db.worktrees.get('ov-1')!;
      await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
      x.fake.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
      await until(() => !!x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic' && s.status === 'running'), WAIT, 'critic session');
      expect(x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic')).toMatchObject({ account: 'cc', token_expires_at: expiry });
    });

    it('records the refreshed expiry a critic starts with, not the stale one', async () => {
      const x = setup(undefined, 3, { reviewRounds: 2 });
      const server = await refreshServer();
      const oldTokenUrl = x.config.anthropicTokenUrl;
      x.config.anthropicTokenUrl = server.url;
      try {
        const stale = Date.now() - 1;
        x.db.accounts.insert({ id: 'cc', name: 'Critic Claude', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'refresh-cc', token_expires_at: stale, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
        criticAccount(x, 'cc');
        const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
        const wt = x.db.worktrees.get('ov-1')!;
        await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
        const before = Date.now();
        x.fake.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
        await until(() => !!x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic' && s.status === 'running'), WAIT, 'critic session');
        const recorded = x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic')!.token_expires_at!;
        const after = Date.now();
        expect(server.requests.length).toBeGreaterThanOrEqual(1);
        expect(recorded).not.toBe(stale);
        expect(recorded).toBeGreaterThanOrEqual(before + 7_200_000);
        expect(recorded).toBeLessThanOrEqual(after + 7_200_000);
      } finally {
        x.config.anthropicTokenUrl = oldTokenUrl;
        await server.close();
      }
    });

    it('records no expiry on a Claude API-key account', async () => {
      const x = setup();
      x.db.accounts.insert({ id: 'ak', name: 'Claude Key', harness: 'claude', kind: 'api_key', secret: 'sk-ant-key', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      claudeStandardAccount(x, 'ak');
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ account: 'ak', token_expires_at: null });
    });

    it('records no expiry on a codex account', async () => {
      const x = setup();
      x.db.accounts.insert({ id: 'cx', name: 'Codex', harness: 'codex', kind: 'codex_home', secret: null, home: '/tmp/codex-home', created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null, account: 'cx' }];
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
      expect(x.db.sessions.get(sid)).toMatchObject({ account: 'cx', token_expires_at: null });
    });

    it('records no expiry on an opencode account', async () => {
      const x = setup();
      x.db.accounts.insert({ id: 'oc', name: 'OpenCode', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'key-oc', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'opencode', model: 'deepseek/flash', effort: null, account: 'oc' }];
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' });
      expect(x.db.sessions.get(sid)).toMatchObject({ account: 'oc', token_expires_at: null });
    });

    it('records no expiry on the CLI\'s own login', async () => {
      const x = setup();
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ account: null, token_expires_at: null });
    });
  });

  describe('a harness passed with a tier', () => {
    /** Codex first in every worker tier, as the defaults are, so a resolution that ignored the forced harness would land on codex. */
    const claudeTiers = (x: ReturnType<typeof setup>, hardClaude: TierCandidate[] = [{ harness: 'claude', model: 'opus', effort: 'high' }]) => {
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) {
        if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }, { harness: 'claude', model: 'sonnet', effort: 'medium' }];
        if (tier.name === 'hard') tier.candidates = [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }, ...hardClaude, { harness: 'opencode', model: 'deepseek/pro', effort: null }];
      }
      x.db.settings.set('tiers', tiers);
    };
    const claudeAccounts = (x: ReturnType<typeof setup>) => {
      for (const id of ['c1', 'c2']) x.db.accounts.insert({ id, name: id, harness: 'claude', kind: 'oauth_token', secret: `token-${id}`, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    };

    it('claude + hard runs on the hard tier\'s claude entry with its effort', async () => {
      const x = setup();
      claudeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
      expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts).toMatchObject({ model: 'opus', effort: 'high' });
    });

    it('claude + standard runs on the standard tier\'s claude entry', async () => {
      const x = setup();
      claudeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'standard' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet', tier: 'standard' });
    });

    it('takes the tier\'s second claude account when the first one is exhausted', async () => {
      const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => (accountId === 'c1' ? { usable: false, reason: 'c1 exhausted' } : { usable: true }));
      const x = setup(undefined, 3, { usageGate });
      claudeAccounts(x);
      claudeTiers(x, [{ harness: 'claude', model: 'opus', effort: 'high', account: 'c1' }, { harness: 'claude', model: 'opus', effort: 'high', account: 'c2' }]);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard', account: 'c2' });
      expect(usageGate.mock.calls.map((call) => call[2])).toEqual(expect.arrayContaining(['c1', 'c2']));
    });

    it('refuses, naming the harness and the tier, when the tier has no claude candidate', async () => {
      const x = setup();
      claudeTiers(x, []);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' })).rejects.toThrow(/^no usable claude candidate in tier hard$/);
    });

    it('refuses with the usage reason when every claude candidate of the tier is exhausted, instead of moving to codex', async () => {
      const x = setup(undefined, 3, { usageGate: async (_db, _config, accountId) => (accountId === 'c1' ? { usable: false, reason: 'c1 exhausted' } : { usable: true }) });
      claudeAccounts(x);
      claudeTiers(x, [{ harness: 'claude', model: 'opus', effort: 'high', account: 'c1' }]);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' })).rejects.toThrow(/^no usable claude candidate in tier hard: c1 exhausted$/);
    });

    it('starts no session when it refuses', async () => {
      const x = setup();
      claudeTiers(x, []);
      await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' }).catch(() => {});
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });

    it('refuses while the forced harness is held by a usage limit, instead of moving to codex', async () => {
      const x = setup();
      claudeTiers(x);
      x.db.settings.set('harness_limits', { claude: Date.now() + 60 * 60 * 1000 });
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' })).rejects.toThrow(/^no usable claude candidate in tier hard: /);
    });

    it('does not step up to the next tier', async () => {
      const x = setup();
      claudeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'standard', stepUp: true });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet', tier: 'standard' });
    });

    it('claude + tier still runs with needs_server', async () => {
      const x = setup();
      claudeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard', needsServer: true });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard', needs_server: 1 });
    });

    it('opencode + tier with needs_server is refused, naming the harness and the tier', async () => {
      const x = setup();
      claudeTiers(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode', tier: 'hard', needsServer: true }))
        .rejects.toThrow(/^ov-1 needs to run a server or a browser, so the forced harness opencode in tier hard was refused: opencode cannot keep a server/);
    });

    it('keeps a forced harness\'s candidates in configured order when a price catalog would sort a later one first', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-prices-')), 'models.dev.json');
      fs.writeFileSync(file, JSON.stringify({ anthropic: { models: { opus: { cost: { input: 15, output: 75 } }, sonnet: { cost: { input: 3, output: 15 } } } } }));
      const catalog = new PriceCatalog(file);
      expect(catalog.load()).toBe(true);
      const x = setup(undefined, undefined, { prices: catalog });
      const tiers = structuredClone(x.db.settings.tiers());
      // The standard tier is price-sorted on a first pick; its two claude entries are listed most expensive first.
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'opus', effort: 'high' }, { harness: 'claude', model: 'sonnet', effort: 'medium' }];
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'standard' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', tier: 'standard' });
    });

    it('records the harness, the tier, the model, the forced harness and the effort the session runs with', async () => {
      const x = setup();
      claudeTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
      // The row has no effort column: the effort is what the harness process was started with.
      expect({ row: x.db.sessions.get(sid), effort: x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.effort })
        .toMatchObject({ row: { harness: 'claude', tier: 'hard', model: 'opus', harness_forced: 1 }, effort: 'high' });
    });

    it('leaves the forced-harness mark off a dispatch by tier alone, harness alone or neither', async () => {
      const x = setup();
      claudeTiers(x);
      for (const id of ['ov-2', 'ov-3']) x.store.add(x.repo.path, { id, title: `Bead ${id}`, description: 'Write a file' });
      const byTier = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'hard' });
      const byHarness = await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude' });
      const byNeither = await x.lc.spawnWorker('r1', 'ov-3');
      expect([byTier, byHarness, byNeither].map((id) => x.db.sessions.get(id)!.harness_forced ?? null)).toEqual([null, null, null]);
    });

    it('a Board re-dispatch keeps the harness and the tier', async () => {
      const x = setup();
      claudeTiers(x);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'standard' });
      x.db.sessions.update(first, { status: 'ended', ended_at: new Date().toISOString() });
      const second = await x.lc.redispatch('ov-1');
      expect(x.db.sessions.get(second)).toMatchObject({ harness: 'claude', model: 'sonnet', tier: 'standard', harness_forced: 1 });
    });

    it('a transient crash retry keeps the harness and the tier', async () => {
      const x = setup();
      claudeTiers(x);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
      const h = x.sessions.handleOf(first)!;
      x.fake.emit(h, { type: 'error', message: 'event stream failed: socket hang up' });
      x.fake.emit(h, { type: 'turn_end', nativeSessionId: '' });
      await until(() => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'transient retry');
      expect(x.db.sessions.forBead('ov-1')[1]).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard', harness_forced: 1 });
    });

    it('a rate-limit re-dispatch takes the tier\'s next claude account, not codex', async () => {
      const x = setup(undefined, 3, { usageGate: async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true } });
      claudeAccounts(x);
      claudeTiers(x, [{ harness: 'claude', model: 'opus', effort: 'high', account: 'c1' }, { harness: 'claude', model: 'opus', effort: 'high', account: 'c2' }]);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
      x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-17T10:00:00.000Z', raw: {} });
      await until(() => x.db.sessions.forBead('ov-1').length === 2 && x.db.sessions.forBead('ov-1')[1]!.status === 'running', WAIT, 'rate-limit re-dispatch');
      expect(x.db.sessions.forBead('ov-1')[1]).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard', account: 'c2', harness_forced: 1 });
    });
  });

  describe('a dispatch that needs a server', () => {
    /** standard has claude after opencode, chore has opencode alone: the flag must reach past the first candidate and can empty a tier. */
    const serverTiers = (x: ReturnType<typeof setup>) => {
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) {
        if (tier.name === 'standard') tier.candidates = [{ harness: 'opencode', model: 'deepseek/flash', effort: null }, { harness: 'claude', model: 'sonnet', effort: null }];
        if (tier.name === 'chore') tier.candidates = [{ harness: 'opencode', model: 'deepseek/chore', effort: null }];
      }
      x.db.settings.set('tiers', tiers);
    };

    it('skips an opencode candidate the tier would otherwise pick', async () => {
      const x = setup();
      serverTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', needsServer: true });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet' });
    });

    it('leaves candidate selection unchanged without the flag', async () => {
      const x = setup();
      serverTiers(x);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'opencode', model: 'deepseek/flash' });
    });

    it('refuses a forced opencode harness instead of starting it', async () => {
      const x = setup();
      serverTiers(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode', needsServer: true }))
        .rejects.toThrow(/needs to run a server or a browser, so the forced harness opencode was refused: opencode cannot keep a server, daemon or browser running.*docs\/server-start-in-a-worker-shell\.md/);
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0); // refused, not started
    });

    it('refuses a forced opencode harness passed alongside a tier, instead of moving it to another harness', async () => {
      const x = setup();
      serverTiers(x);
      // harness with a tier forces that CLI within the tier, so it is refused like a forced harness without one.
      await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', harness: 'opencode', needsServer: true }))
        .rejects.toThrow(/needs to run a server or a browser, so the forced harness opencode in tier standard was refused/);
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0); // refused, not started
    });

    it('keeps the flag on a later re-dispatch of the same bead', async () => {
      const x = setup();
      serverTiers(x);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', needsServer: true });
      expect(x.db.sessions.get(first)).toMatchObject({ harness: 'claude', needs_server: 1 });
      x.db.sessions.update(first, { status: 'ended', ended_at: new Date().toISOString() });
      // The user's Re-dispatch carries no flag of its own; without the recorded one the tier would now pick the untried opencode candidate.
      const second = await x.lc.redispatch('ov-1');
      expect(x.db.sessions.get(second)).toMatchObject({ harness: 'claude', needs_server: 1 });
    });

    it('refuses with the reason when the flag leaves no usable candidate', async () => {
      const x = setup();
      serverTiers(x);
      await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'chore', needsServer: true }))
        .rejects.toThrow(/no usable harness for tier chore: opencode cannot keep a server, daemon or browser running/);
      expect(x.db.sessions.forBead('ov-1')).toHaveLength(0);
    });
  });

  it('records a stop that reached the worker after it had committed, instead of letting the work land silently (round 20 R20-1)', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting'); // the worker committed before the Stop reached it
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    // The bead does not go back to Ready, which is what the Board promises: the branch has the work, so it is verified and reviewed.
    expect(await x.status()).toBe('in_progress');
    const notes = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    // Neither line names bead/ov-1: that branch is gone as soon as the bead integrates (fix round 20 review NB-C).
    expect(notes).toContain(`Stopped by the user from the Board (worker session ${sid}), after it had committed: its commits are kept and the bead goes on to verification`);
    expect(notes).not.toContain(wt.branch);
    expect(x.notes).toEqual([
      'ov-1 stopped by the user from the Board after it had already committed; its commits are kept and the bead goes on to verification instead of back to Ready.',
      'ov-1 is in review; verify command `node -e "process.exit(0)"` passed',
    ]);
    expect(x.hints[0]).toBe('Do not re-dispatch it unless the user asks.');
    expect(x.wakes).toEqual([x.notes[1]]); // the stop itself is informational; the review notice wakes
  });

  it('records the stop and verifies when a stopped worker committed and left the worktree dirty', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting'); // committed before the Stop reached it
    fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'hi there\n'); // an edit the stop left uncommitted
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(await x.status()).toBe('in_progress');
    const notes = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect(notes).toContain(`Stopped by the user from the Board (worker session ${sid}), after it had committed`);
    expect(notes).not.toContain('left uncommitted changes');
    expect(x.notes).toContain('ov-1 is in review; verify command `node -e "process.exit(0)"` passed');
  });

  it('settles the bead even when bd cannot record the stop-after-commit note (fix round 20 review NB-A)', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    const update = x.store.update.bind(x.store);
    const spy = vi.spyOn(x.store, 'update').mockImplementation(async (p, id, patch) => {
      if (patch.note?.includes('after it had committed')) { spy.mockRestore(); throw new Error('bd update failed: database is locked'); }
      return update(p, id, patch);
    });
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    let logged: string[] = [];
    try {
      await x.lc.interruptBead('ov-1');
      // The note is informational; losing it must not abort the settle and leave the card in "settling..." for good.
      await until(async () => (await x.phase()) === 'review', WAIT, 'review');
      logged = error.mock.calls.map((c) => String(c[0]));
    } finally {
      error.mockRestore();
    }
    expect(logged.some((m) => /stop-after-commit note failed/.test(m))).toBe(true);
    expect(await x.status()).toBe('in_progress');
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
  });

  it('keeps a failed verification through a re-dispatch whose worker is stopped before it commits (round 21 R21-1)', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Keep');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('fail');

    const sid2 = await x.lc.redispatch('ov-1');
    // The new worker runs on the branch that failed: the row keeps the failure, and the card says running, not failed.
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('fail');
    const running = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(running.column).toBe('running');
    expect(running.verify_failure).toBeNull();

    await x.lc.interruptBead('ov-1'); // stopped before it committed anything
    await until(async () => (await x.status()) === 'open', WAIT, 'back in Ready');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain(`Stopped by the user from the Board (worker session ${sid2}, no new commits)`);
    const card = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(card.column).toBe('ready');
    expect(card.state).toBe('verify_failed');
    expect(card.verify_failure).toMatch(/exit 1$/);
  });

  it('blocks request_merge when verification fails', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a', 'a');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review');
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('fail');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(1)"` failed']);
    await expect(x.lc.requestMerge('r1', 'ov-1', 'please')).rejects.toBeInstanceOf(LifecycleError);
  });

  it('reject keeps the worktree and the re-dispatch carries the note', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wtPath = x.db.worktrees.get('ov-1')!.path;
    await commitFileAsync(wtPath, 'a.txt', 'a', 'a');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review');
    await x.lc.requestMerge('r1', 'ov-1', 'ship it');
    expect(x.db.worktrees.get('ov-1')?.review_note).toBe('ship it');
    const png = Buffer.from('proof');
    await x.lc.reject('ov-1', 'needs tests', [{ name: 'proof.png', mime: 'image/png', data: png }]);
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBe('rejected');
    expect(x.db.worktrees.get('ov-1')?.review_note).toBeNull();
    expect(x.wakes.at(-1)).toBe('ov-1 rejected by the user: needs tests. Re-dispatch it with instructions that address the note.'); // "the orchestrator was notified" holds for a v1 bead too
    const stored = x.storedAttachments.filter((attachments) => attachments.length > 0).at(-1)![0]!;
    expect(path.isAbsolute(stored.path)).toBe(true);
    expect(fs.readFileSync(stored.path)).toEqual(png);
    expect(fs.existsSync(wtPath)).toBe(true);
    const sid2 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', instructions: 'add a unit test' });
    expect(x.db.worktrees.get('ov-1')?.path).toBe(wtPath);
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toBe(`Rejected: needs tests\nAttachment: ${stored.path}\nRe-dispatched to claude`); // the rejection now reads as history
    const prompt = x.fake.sent(x.sessions.handleOf(sid2)!)[0]!;
    expect(prompt).toContain('needs tests');
    expect(prompt).toContain('add a unit test');
  });

  // Round 25 nit: "repo2-ngx closed as won't do by the user from the Board: Not needed for round 25.." — the template added a full stop the user's note already had.
  it("does not double the full stop of a note the user wrote, in the close and the reject notice", async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Never started' });
    await x.lc.closeBead('ov-2', 'Not needed for round 25.');
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board: Not needed for round 25.");
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Also never started' });
    await x.lc.closeBead('ov-3', 'Not needed either'); // one without its own full stop still gets the template's
    expect(x.notes.at(-1)).toBe("ov-3 closed as won't do by the user from the Board: Not needed either.");
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a', 'a');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review');
    await x.lc.reject('ov-1', 'Needs tests.');
    expect(x.wakes.at(-1)).toBe('ov-1 rejected by the user: Needs tests. Re-dispatch it with instructions that address the note.');
  });

  // Round 25 R25-4: the Board offers Close bead on a blocked card now, and bd 1.2.2 refuses to close a bead whose blockers are open.
  it("closes a blocked bead from the Board, past bd's own gate", async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Waits for ov-1' }, ['ov-1']);
    await expect(x.store.close(x.repo.path, 'ov-2', 'plain')).rejects.toThrow(/blocked by open issues/); // what bd answers without --force
    await x.lc.closeBead('ov-2', 'not wanted');
    expect(await x.status('ov-2')).toBe('closed');
    expect(await x.phase('ov-2')).toBe('closed');
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board: not wanted.");
    expect(await x.status('ov-1')).toBe('open'); // the blocker is not its business
  });

  // Round 26 R26-2: --force also overrides bd's pinned and gate guards, and `dependency_count` counts closed dependencies too, so
  // the old `> 0` condition forced beads bd would have closed on its own.
  it('forces the close past bd only while a blocker of the bead is still open', async () => {
    const x = setup();
    const close = vi.spyOn(x.store, 'close');
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Waits for ov-1' }, ['ov-1']); // ov-1 is open
    x.store.add(x.repo.path, { id: 'ov-0', title: 'Done long ago', status: 'closed' });
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Waited for ov-0' }, ['ov-0']); // one dependency, none of them open
    await x.lc.closeBead('ov-2', 'not wanted');
    expect(close.mock.calls.at(-1)![3]).toEqual({ force: true });
    await x.lc.closeBead('ov-3', 'not wanted either');
    expect(close.mock.calls.at(-1)![3]).toEqual({ force: false });
    expect([await x.status('ov-2'), await x.status('ov-3')]).toEqual(['closed', 'closed']);
  });

  // Round 26 R26-2: Abandon closes every bead of the batch the same way, so it narrows the same condition.
  it('abandons a batch forcing only the bead a blocker still holds', async () => {
    const x = setup();
    const close = vi.spyOn(x.store, 'close');
    x.store.add(x.repo.path, { id: 'ov-0', title: 'Done long ago', status: 'closed' });
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Waited for ov-0', labels: ['overseer:batch:r1-b1'] }, ['ov-0']);
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Waits for ov-1', labels: ['overseer:batch:r1-b1'] }, ['ov-1']);
    await x.lc.createBatch('r1', 'Two beads');
    await x.lc.abandonBatch('r1-b1');
    expect(close.mock.calls.map((c) => [c[1], c[3]])).toEqual([['ov-2', { force: false }], ['ov-3', { force: true }]]);
    expect([await x.status('ov-2'), await x.status('ov-3')]).toEqual(['closed', 'closed']);
  });

  it('rolls back a batch a plan approval just created: beads closed, worktree and branch gone, row deleted, nothing said', async () => {
    const x = setup();
    const batch = await x.lc.createBatch('r1', 'Rolled back');
    const a = await x.store.create(x.repo.path, { title: 'A', description: '', labels: [`overseer:batch:${batch.id}`], blockedBy: [] });
    const b = await x.store.create(x.repo.path, { title: 'B', description: '', labels: [`overseer:batch:${batch.id}`], blockedBy: [a] });
    const wt = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    expect(fs.existsSync(wt)).toBe(true);

    await x.lc.rollbackBatch(batch.id);

    expect(x.db.batches.get(batch.id)).toBeUndefined();
    expect(fs.existsSync(wt)).toBe(false);
    expect(await shAsync(x.repo.path, ['branch', '--list', batch.branch])).toBe('');
    expect((await x.store.show(x.repo.path, a))?.status).toBe('closed');
    expect((await x.store.show(x.repo.path, b))?.status).toBe('closed');
    expect(x.notes).toEqual([]);
    await x.lc.rollbackBatch('r1-b99'); // unknown: nothing to do
  });

  // Round 26 nit: the clauses that follow the note turned "Not needed for round 26." into "Not needed for round 26.; batch …".
  it("does not leave the user's full stop in front of the clauses that follow the note", async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Never started', labels: ['overseer:batch:r1-b1'] });
    await x.lc.createBatch('r1', 'One bead');
    await x.lc.closeBead('ov-2', 'Not needed for round 26.');
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board: Not needed for round 26; batch r1-b1 stays open (0/1 beads done, 1 closed).");
  });

  // Fix round 26 review: the strip took the full stop only, so a note ending in "!" or "?" still read "…!; batch …".
  it("drops an exclamation mark or a question mark at the end of the note too", async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Never started', labels: ['overseer:batch:r1-b1'] });
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Never started either', labels: ['overseer:batch:r1-b1'] });
    await x.lc.createBatch('r1', 'Two beads');
    await x.lc.closeBead('ov-2', 'Not needed!');
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board: Not needed; batch r1-b1 stays open (0/2 beads done, 1 closed).");
    await x.lc.closeBead('ov-3', 'Why would we?');
    expect(x.notes.at(-1)).toBe("ov-3 closed as won't do by the user from the Board: Why would we; batch r1-b1 stays open (0/2 beads done, 2 closed).");
  });

  // Fix round 26 review: `dependents` and `blockers` were the same `bd blocked` command with opposite filters, run one after the other.
  it('reads bd blocked once on the Close path and derives both directions from it', async () => {
    const x = setup();
    const blocked = vi.spyOn(x.store, 'blocked');
    const close = vi.spyOn(x.store, 'close');
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Waits for ov-1' }, ['ov-1']); // ov-1 is open: the close needs --force
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Waits for ov-2' }, ['ov-2']); // and ov-3 waited on ov-2
    await x.lc.closeBead('ov-2', 'not wanted');
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(close.mock.calls.at(-1)![3]).toEqual({ force: true });
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board: not wanted; ov-3 waited on it and is ready in bd now.");
  });

  it('merge conflict stores files, notifies, and feeds the next worker prompt', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wtPath = x.db.worktrees.get('ov-1')!.path;
    await commitFileAsync(wtPath, 'README.md', '# branch\n', 'b');
    await commitFileAsync(x.repo.path, 'README.md', '# main\n', 'm');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review');
    await x.lc.requestMerge('r1', 'ov-1', 'note');
    await expect(x.lc.merge('ov-1')).rejects.toBeInstanceOf(MergeConflictError);
    expect(x.db.worktrees.get('ov-1')?.conflict_files).toEqual(['README.md']);
    expect(await x.phase()).toBe('review');
    expect(x.notes.at(-1)).toContain('README.md');
    await x.lc.reject('ov-1', 'rebase please');
    const sid2 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.fake.sent(x.sessions.handleOf(sid2)!)[0]).toContain('- README.md');
  });

  it('refuses duplicates, closed beads, limit, and missing bd', async () => {
    const x = setup(undefined, 1);
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Second' });
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow(/already has a running session/);
    await expect(x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude' })).rejects.toThrow(/worker limit/);
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Done', status: 'closed' });
    await expect(x.lc.spawnWorker('r1', 'ov-3', { harness: 'claude' })).rejects.toThrow(/is closed/);
    x.store.unavailable = true;
    await expect(x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude' })).rejects.toThrow(/bd is not available/);
  });

  it('refuses to dispatch while the verify command fails on the base branch', async () => {
    const x = setup();
    const run = x.db.preflight.insert({ repo_id: 'r1', kind: 'verify_probe', command: 'bad', head_sha: 'abcdef1234' });
    x.db.preflight.finish(run.id, { result: 'fail', exit_code: 1, output_tail: 'exit 1' });
    x.db.repos.update('r1', { verify_suspect: run.id });
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow('verify command "bad" exits 1 on main at abcdef1; fix it in Setup → Edit, then Re-probe');
    expect(x.db.sessions.forBead('ov-1')).toEqual([]);
    x.db.repos.update('r1', { verify_suspect: null });
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).resolves.toEqual(expect.any(String));
  });

  it('recover applies the session-end rule to lost sessions', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wtPath = x.db.worktrees.get('ov-1')!.path;
    await commitFileAsync(wtPath, 'a.txt', 'a', 'a');
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: { ...loadConfig({}), worktreesDir: path.dirname(path.dirname(wtPath)) }, provider: () => new LocalMergeProvider(), notify: async () => {} });
    await fresh.recover();
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    await until(async () => (await x.phase()) === 'review');
  });

  it('recover publishes session:reaped for a lost worker, so a socket that connected during recovery still gets the leave', async () => {
    // The manager's `finish` is what emits `session:ended`, and recovery bypasses it: without this event a socket that connected
    // while recovery was still working through its list would be re-sent the row's `walking_in` and never see it leave.
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a', 'a'); // with a commit the session stays `ended`, not reopened as failed
    const reaped: string[] = [];
    x.bus.on('session:reaped', (s) => reaped.push(s.id));
    await x.lc.recover();
    expect(reaped).toEqual([sid]);
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
  });

  it('recover publishes session:reaped for a lost orchestrator session, which no session:ended covers', async () => {
    const x = setup();
    x.db.sessions.insert({ id: 'o-lost', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/x', batch_id: null, log_path: null, log_offset: 0, tier: null, model: null, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null });
    const reaped: string[] = [];
    x.bus.on('session:reaped', (s) => reaped.push(s.id));
    await x.lc.recover();
    expect(reaped).toEqual(['o-lost']);
    expect(x.db.sessions.get('o-lost')).toMatchObject({ status: 'ended', pid: null });
  });

  it('recover reopens a lost worker with the restart note even when its branch already has commits', async () => {
    // A re-dispatch after a failed verification: the branch carries the first worker's commit, the second worker is killed with the daemon.
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Crash');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    const sid2 = await x.lc.redispatch('ov-1');
    x.db.repos.update('r1', { verify_command: `node -e "process.exit(0)"` }); // the command would pass now: recovery must still not land the interrupted branch
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m, o) => { x.notes.push(m); if (o?.wake) x.wakes.push(m); } });
    await fresh.recover();
    expect(x.db.sessions.get(sid2)?.status).toBe('failed');
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toMatch(/daemon restarted while the worker was running$/);
    expect(x.wakes.at(-1)).toMatch(/^ov-1 reopened: worker ended without commits on claude: daemon restarted/);
    expect(x.db.worktrees.get('ov-1')?.merged_at).toBeNull();
  });

  it('recover logs and continues when a lost session cannot be settled', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    fs.rmSync(x.db.worktrees.get('ov-1')!.path, { recursive: true, force: true });
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    try {
      await expect(x.lc.recover()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining(sid), expect.anything());
    } finally {
      error.mockRestore();
    }
    expect(['ended', 'failed']).toContain(x.db.sessions.get(sid)?.status);
  });

  it('recover adopts a live worker process instead of reopening its bead', async () => {
    const x = setup();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-adopt-')), 'w.log');
    const child = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
    try {
      const pid = child.pid!;
      const startedAt = await processStartTime(pid);
      expect(startedAt).toBeTruthy();
      expect(await isAlive(pid, startedAt)).toBe(true);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      await until(() => x.db.sessions.get(sid)?.pid === 4242, WAIT, 'fake pid recorded');
      x.db.sessions.update(sid, { pid, pid_started_at: startedAt, log_path: logFile, log_offset: 3 });
      const info = scopedSpy(console, 'log').mockImplementation(() => {});
      try {
        await x.lc.recover();
        expect(info).toHaveBeenCalledWith(expect.stringContaining(`adopted worker ${sid} for ov-1`), '');
      } finally { info.mockRestore(); }
      expect(await isAlive(pid, startedAt)).toBe(true);
      expect(x.db.sessions.get(sid)).toMatchObject({ status: 'running', pid });
      expect(x.sessions.isLive(sid)).toBe(true);
      expect([...x.fake.sessions.values()].at(-1)?.adopted).toMatchObject({ pid, logFile, logOffset: 3 });
      expect(await x.status()).toBe('in_progress');
      expect(x.wakes).toEqual([]);
      expect(x.sessions.status(sid)).toMatchObject({ state: 'running', files: [] });
    } finally {
      await killProcess(child.pid!);
    }
  });

  it('recover reopens a worker whose process is gone, with the exit reason from the end of its log', async () => {
    const x = setup();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-dead-')), 'w.log');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => child.on('exit', r));
    fs.writeFileSync(logFile, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n' + JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'API rate limit reached' }) + '\n');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await until(() => x.db.sessions.get(sid)?.pid === 4242, WAIT, 'fake pid recorded');
    x.db.sessions.update(sid, { pid: child.pid!, pid_started_at: '2026-01-01T00:00:00.000Z', log_path: logFile });
    await x.lc.recover();
    expect(x.db.sessions.get(sid)).toMatchObject({ status: 'failed', pid: null });
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain("daemon restarted while the worker was running; the worker's log ends with: API rate limit reached");
    expect(x.wakes.at(-1)).toMatch(/^ov-1 reopened: worker ended without commits on claude: daemon restarted/);
  });

  it('Stop worker kills an adopted worker and the session-end rule records the stop', async () => {
    const x = setup();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-stop-')), 'w.log');
    const child = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
    const real = new SessionManager(x.db, { claude: new ClaudeAdapter('claude') }, x.bus, LOG_DIR);
    const lc = new Lifecycle({ db: x.db, store: x.store, sessions: real, bus: x.bus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m) => { x.notes.push(m); } });
    try {
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' }); // the row and worktree; the fake never talks to the process
      await until(() => x.db.sessions.get(sid)?.pid === 4242, WAIT, 'fake pid recorded');
      const pid = (await child.pidReady)!; // on Windows the worker's pid, which the launcher reports after spawn
      x.db.sessions.update(sid, { pid, pid_started_at: await processStartTime(pid), log_path: logFile });
      await lc.recover();
      expect(real.isLive(sid)).toBe(true);
      await lc.interruptBead('ov-1');
      await until(() => !pidExists(pid), WAIT, 'adopted process killed');
      await until(async () => (await x.status()) === 'open', WAIT, 'reopened after the stop');
      expect(x.db.sessions.get(sid)).toMatchObject({ status: 'ended', pid: null });
      expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toMatch(/^Stopped by the user from the Board/);
    } finally {
      await killProcess(child.pid!).catch(() => {});
    }
  });

  it('records a stop the settle never saw in memory as a stop, not as a failure', async () => {
    // The losing order of the two observations: the stop is asked of the session manager, which writes the `interrupt` event and
    // records the row as `ended`, while the settle runs with no in-memory stop for that session (another Lifecycle over the same
    // database, a daemon that restarted). It used to reach the crash rule and overwrite the row with `failed`.
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await x.sessions.interrupt(sid, { by: 'user' });
    await until(async () => (await x.status()) === 'open', 5000, 'reopened after the stop');
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toMatch(/^Stopped by the user from the Board/);
  });

  it('records a stop whose process died before the stop finished as a stop, not as a failure', async () => {
    // The other losing order: the kill makes the stream end, and the settle runs before `interrupt` has written its event, with
    // no in-memory stop for that session either. The stop travels on the session-end event itself, so neither record is needed.
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const end = x.fake.end.bind(x.fake);
    x.fake.interrupt = async (h) => { await end(h); await new Promise((r) => setTimeout(r, 20)); }; // the stream dies before interrupt returns
    await x.sessions.interrupt(sid, { by: 'user' });
    await until(async () => (await x.status()) === 'open', 5000, 'reopened after the stop');
    expect(x.db.sessions.get(sid)?.status).toBe('ended');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toMatch(/^Stopped by the user from the Board/);
  });

  it('settles a worker that died on its own as a failure, with no stop asked for', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'error', message: 'claude exited with code 1' });
    await x.sessions.end(sid);
    await until(async () => (await x.status()) === 'open', 5000, 'reopened after the crash');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).not.toMatch(/Stopped by/);
  });

  it('reopens a bead whose branch holds only a merge from its base (overseer-xen: a dead worker had run git merge main)', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(x.repo.path, 'other.txt', 'x\n', 'main moves on'); // so the merge is a real merge commit, not a fast-forward
    await shAsync(wt.path, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'merge', '--no-ff', '-m', 'Merge branch main into bead/ov-1', 'main']);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Starting on it.' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect(x.notes).toEqual(['ov-1 reopened: worker ended without commits (only merge commits) on claude: Starting on it.']);
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('ended without new commits (only merge commits)');
  });

  it('lands a branch that has a real commit next to a merge from its base', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(x.repo.path, 'other.txt', 'x\n', 'main moves on');
    await shAsync(wt.path, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'merge', '--no-ff', '-m', 'Merge branch main into bead/ov-1', 'main']);
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
  });

  it('reopens a bead whose commits leave an empty diff against its base', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    await shAsync(wt.path, ['rm', '-q', 'hello.txt']);
    await shAsync(wt.path, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'remove greeting again']);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Done.' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.notes).toEqual(['ov-1 reopened: worker ended without commits (empty diff) on claude: Done.']);
  });

  // A re-dispatched bead's branch carries the merge commits of earlier batch-branch refreshes (acme-portal-sample-046, 2026-09-26).
  /** A verify-only worker on claude whose branch holds only a merge from its base; resolves with the session id. */
  async function verifyOnlyAfterMerge(x: ReturnType<typeof setup>, verifyCommand?: string) {
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, ...(verifyCommand ? { verifyCommand } : {}) });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(x.repo.path, 'other.txt', 'x\n', 'main moves on');
    await shAsync(wt.path, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'merge', '--no-ff', '-m', 'Merge branch main into bead/ov-1', 'main']);
    return sid;
  }

  it('closes a verify_only bead as worker-reported when its branch holds only merge commits and every check passes', async () => {
    const x = setup();
    const sid = await verifyOnlyAfterMerge(x);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'worker-reported notice');
    const bead = await x.store.show(x.repo.path, 'ov-1');
    expect({ status: bead?.status, phase: await x.phase(), labels: bead?.labels, notes: bead?.notes, notice: x.notes[0] }).toMatchObject({
      status: 'closed',
      phase: 'worker-reported',
      labels: expect.arrayContaining(['overseer:worker-reported']),
      notes: expect.stringContaining('closed: worker-reported result, no commits'),
      notice: 'ov-1 closed as worker-reported: the worker reported its result and committed nothing.',
    });
  });

  it('reopens a verify_only bead with only merge commits as verify_incomplete when a check fails', async () => {
    const x = setup();
    const sid = await verifyOnlyAfterMerge(x);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)\nCheck: pnpm typecheck - FAIL - one error' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && x.notes.length > 0, WAIT, 'verify incomplete reopen');
    expect(x.notes).toEqual(['ov-1 reopened: verification-only result is incomplete; the following Check: lines did not PASS:\n> Check: pnpm typecheck - FAIL - one error']);
  });

  it('reopens a verify_only bead with only merge commits as verify_incomplete when no Check line is reported', async () => {
    const x = setup();
    const sid = await verifyOnlyAfterMerge(x);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'All looks fine.' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && x.notes.length > 0, WAIT, 'verify incomplete reopen');
    expect(x.notes).toEqual(['ov-1 reopened: verification-only result is incomplete; no Check: lines were reported.']);
  });

  it('closes a verify_only bead with only merge commits as verified when its verify_command passes', async () => {
    const x = setup();
    const command = `node -e "console.log('Tests 3 passed (3)')"`;
    const sid = await verifyOnlyAfterMerge(x, command);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: `Check: ${command} - PASS - Tests 3 passed (3)` });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'verified notice');
    expect({ status: await x.status(), phase: await x.phase(), result: x.db.worktrees.get('ov-1')?.verify_only_result, notice: x.notes[0] }).toMatchObject({
      status: 'closed', phase: 'verified', result: { status: 'pass', command, exit_code: 0 }, notice: 'ov-1 closed as verified: the daemon ran its verify command and it passed and committed nothing.',
    });
  });

  it('reopens a verify_only bead with only merge commits as verify_incomplete with the output tail when its verify_command fails', async () => {
    const x = setup();
    const command = `node -e "console.log('Tests 1 failed (1)'); process.exit(3)"`;
    const sid = await verifyOnlyAfterMerge(x, command);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Ran it.' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && x.notes.length > 0, WAIT, 'verify command failure reopen');
    expect({ note: (await x.store.show(x.repo.path, 'ov-1'))?.notes, notice: x.notes[0] }).toMatchObject({
      note: expect.stringMatching(/Verification incomplete: daemon verify command .* failed with exit code 3 at [0-9a-f]+\.\nDaemon output tail:\n(> .*\n)*> Tests 1 failed \(1\)\n(> .*\n)*> exit 3/),
      notice: expect.stringMatching(/^ov-1 reopened: verification-only result is incomplete; daemon verify command /),
    });
  });

  it('closes a verify_only bead as worker-reported when its commits leave an empty diff and every check passes', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    await shAsync(wt.path, ['rm', '-q', 'hello.txt']);
    await shAsync(wt.path, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'remove greeting again']);
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'worker-reported notice');
    expect({ status: await x.status(), phase: await x.phase(), notice: x.notes[0] }).toMatchObject({
      status: 'closed', phase: 'worker-reported', notice: 'ov-1 closed as worker-reported: the worker reported its result and committed nothing.',
    });
  });

  it('keeps the restart reopen for a lost verify_only worker whose branch holds only merge commits', async () => {
    const x = setup();
    const sid = await verifyOnlyAfterMerge(x);
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m, o) => { x.notes.push(m); if (o?.wake) x.wakes.push(m); } });
    await fresh.recover();
    expect({ session: x.db.sessions.get(sid)?.status, status: await x.status(), wake: x.wakes.at(-1) }).toMatchObject({
      session: 'failed', status: 'open', wake: expect.stringMatching(/^ov-1 reopened: worker ended without commits \(only merge commits\) on claude: daemon restarted while the worker was running/),
    });
  });

  it('reopens a bead whose worker committed work but left a tracked file modified, and does not verify (overseer-gk52)', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'hi there\n'); // the fix itself, never committed
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Fixed and tested.' });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect(await x.phase()).toBeNull();
    const notes = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect(notes).toContain('left uncommitted changes in its worktree (modified: hello.txt)');
    expect(notes).toContain('they are not on bead/ov-1 and would be lost at the merge');
    expect(x.notes).toEqual(['ov-1 reopened: the worker left uncommitted changes in its worktree (modified: hello.txt); they are not on bead/ov-1 and would be lost at the merge.']);
    expect(x.wakes).toEqual(x.notes);
    expect(x.hints.at(-1)).toContain('commit the work');
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBeNull(); // verification never ran in the dirty worktree
  });

  it('reopens a bead whose worker committed work but left a new untracked file', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    fs.writeFileSync(path.join(wt.path, 'hello.test.ts'), 'test\n'); // a new test never added to git
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.notes).toEqual(['ov-1 reopened: the worker left uncommitted changes in its worktree (untracked: hello.test.ts); they are not on bead/ov-1 and would be lost at the merge.']);
  });

  it('reopens again when a re-dispatch leaves the previous attempt\'s uncommitted file still uncommitted', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'hi there\n'); // never committed
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopen');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');

    // The re-dispatch reuses the same dirty worktree; only the worktree's state at creation is subtracted, so the leftover edit
    // still counts when the new worker commits nothing either (a naive per-session snapshot would swallow it).
    const sid2 = await x.lc.redispatch('ov-1');
    x.finishTurn(sid2);
    await until(async () => x.db.sessions.get(sid2)?.status === 'failed', WAIT, 'second reopen');
    expect(x.notes.at(-1)).toBe('ov-1 reopened: the worker left uncommitted changes in its worktree (modified: hello.txt); they are not on bead/ov-1 and would be lost at the merge.');
    expect(await x.status()).toBe('open');
  });

  it('lands a worker whose only extra file is gitignored', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, '.gitignore', '.playwright-cli/\n', 'ignore evidence files');
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    fs.mkdirSync(path.join(wt.path, '.playwright-cli'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, '.playwright-cli', 'shot.png'), 'x');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('pass');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
  });

  it('does not count the setup command\'s own untracked output as work the worker left uncommitted', async () => {
    const x = setup();
    x.db.repos.update('r1', { setup_command: `node -e "require('fs').writeFileSync('setup.txt', 'ok')"` });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    expect(fs.existsSync(path.join(wt.path, 'setup.txt'))).toBe(true); // left by the setup command, not by the worker
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('pass');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
  });

  it('reopens after a daemon restart because the creation snapshot lives on the worktree row', async () => {
    const x = setup();
    x.db.repos.update('r1', { setup_command: `node -e "require('fs').writeFileSync('setup.txt', 'ok')"` });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    expect(x.db.worktrees.get('ov-1')?.created_dirty).toEqual({ modified: [], untracked: ['setup.txt'] }); // on the row, not in memory
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'hi there\n'); // the fix itself, never committed
    // A fresh lifecycle stands for a restarted daemon: its in-memory state is empty, so only the row can carry the snapshot.
    const bus = new Bus();
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m, o) => { x.notes.push(m); x.hints.push(o?.hint); if (o?.wake) x.wakes.push(m); } });
    bus.emit('session:ended', { session: x.db.sessions.get(sid)!, lastText: 'Fixed and tested.', lastError: null, files: [] });
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened after the restart');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
    expect(x.notes).toEqual(['ov-1 reopened: the worker left uncommitted changes in its worktree (modified: hello.txt); they are not on bead/ov-1 and would be lost at the merge.']);
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBeNull(); // verification never ran in the dirty worktree
  });

  it('still verifies a worker that committed and left a clean worktree', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('pass');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
  });

  it('still closes a verify_only bead as worker-reported when its worktree is clean', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => x.notes.length > 0, WAIT, 'verified notice');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('worker-reported');
    expect(x.notes).toEqual(['ov-1 closed as worker-reported: the worker reported its result and committed nothing.']);
  });

  it('batches: create, dispatch onto the branch, integrate on pass, review, merge', async () => {
    const x = setup();
    const b = await x.lc.createBatch('r1', 'Trend chart');
    expect(b).toMatchObject({ id: 'r1-b1', branch: 'feature/trend-chart', status: 'open' });
    expect(await shAsync(x.repo.path, ['branch', '--list', 'feature/trend-chart'])).toContain('feature/trend-chart');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    expect(wt.batch_id).toBe('r1-b1');
    expect(wt.base_branch).toBe('feature/trend-chart');
    expect(x.fake.sent(x.sessions.handleOf(sid)!)[0]).toContain('based on `feature/trend-chart`');
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await shAsync(x.repo.path, ['show', 'feature/trend-chart:hello.txt'])).toBe('hi');
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/trend-chart (1/1 beads done; verify command `node -e "process.exit(0)"` passed)');
    // Conventional Commits merge message, so a commitlint commit-msg hook in the managed repo accepts it; the body carries the title and source.
    expect((await shAsync(x.repo.path, ['log', '-1', '--format=%B', 'feature/trend-chart'])).trim()).toBe('chore(trend-chart): merge ov-1\n\nAdd greeting\nSource: bead/ov-1');

    await x.lc.requestBatchReview('r1', 'r1-b1', 'Adds hello.txt');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'Adds hello.txt' });
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b1')?.status).toBe('merged');
    expect(fs.existsSync(path.join(x.repo.path, 'hello.txt'))).toBe(true);
    expect((await shAsync(x.repo.path, ['log', '-1', '--format=%B', 'main'])).trim()).toBe('chore(main): merge r1-b1\n\nTrend chart\nSource: feature/trend-chart\n\nAdds hello.txt');
    expect(await shAsync(x.repo.path, ['branch', '--list', 'feature/trend-chart'])).toBe('');
    expect(fs.existsSync(batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1'))).toBe(false);
    expect(x.notes.at(-1)).toMatch(/^Batch r1-b1 merged into main \([0-9a-f]{7}\) by the user; feature\/trend-chart was deleted\.$/);
    // The finished batch stays inspectable: merge commit, bead link, counts and cost survive the cleanup.
    expect(x.db.batches.get('r1-b1')?.merged_commit).toBe(await shAsync(x.repo.path, ['rev-parse', 'HEAD']));
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ batch_id: 'r1-b1', merged_at: expect.any(String) });
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[0]).toMatchObject({ id: 'r1-b1', status: 'merged', beads_total: 1, beads_done: 1, cost: 0.1 });
    // A session that ends against the merged batch (its folder is gone) has nothing to settle and must not throw.
    const stale = x.db.sessions.get(sid)!;
    x.bus.emit('session:ended', { session: { ...stale, status: 'ended' }, lastText: null, lastError: null, files: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(await x.status()).toBe('closed');
    expect(x.db.batches.get('r1-b1')?.status).toBe('merged');
  });

  it('batches: a second Merge while the first is in flight is refused with a reason, not a 500', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Trend chart');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'Adds hello.txt');
    const [first, second] = await Promise.allSettled([x.lc.mergeBatch('r1-b1'), x.lc.mergeBatch('r1-b1')]);
    expect(first!.status).toBe('fulfilled');
    expect(second!.status).toBe('rejected');
    const err = (second as PromiseRejectedResult).reason as Error;
    expect(err).toBeInstanceOf(LifecycleError);
    expect(err.message).toBe('batch r1-b1 is being merged');
    expect(x.db.batches.get('r1-b1')?.status).toBe('merged');
    expect((await shAsync(x.repo.path, ['log', '--first-parent', '--merges', '--oneline', 'main'])).split('\n').filter(Boolean)).toHaveLength(1);
    // Once merged, a replay is refused with the state, as before.
    await expect(x.lc.mergeBatch('r1-b1')).rejects.toThrow('batch r1-b1 is not in review');
  });

  it('batches: Abandon is refused while a Merge is in flight, and the merge lands alone', async () => {
    const g = gatedMerge();
    const x = setup(undefined, 3, { provider: g.provider });
    await batchInReview(x);
    const merging = x.lc.mergeBatch('r1-b1');
    await g.entered;
    await expect(x.lc.abandonBatch('r1-b1')).rejects.toThrow('batch r1-b1 is being merged');
    g.open();
    await merging;
    // Only the merge took effect: no abandoned label, no abandon notice, and one merge commit.
    expect(x.db.batches.get('r1-b1')?.status).toBe('merged');
    expect(await x.phase()).toBe('merged');
    expect(x.notes.some((n) => n === 'Batch r1-b1 abandoned by the user')).toBe(false);
    expect(x.notes.filter((n) => n.includes('merged into'))).toHaveLength(1);
    expect((await shAsync(x.repo.path, ['log', '--first-parent', '--merges', '--oneline', 'main'])).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('batches: Merge is refused while an Abandon is in flight, and the base tip does not move', async () => {
    const x = setup();
    await batchInReview(x);
    const base = await shAsync(x.repo.path, ['rev-parse', 'main']);
    // Hold the abandon at its retrospective, after it marked the batch and while its guard is still held.
    const held = holdRetrospective(x.lc);
    try {
      const abandoning = x.lc.abandonBatch('r1-b1');
      await held.entered;
      await expect(x.lc.mergeBatch('r1-b1')).rejects.toThrow('batch r1-b1 is being abandoned');
      expect(x.db.batches.get('r1-b1')?.status).toBe('abandoned'); // the abandon went through; the merge never started
      held.open();
      await abandoning;
    } finally {
      held.restore();
    }
    expect(x.db.batches.get('r1-b1')?.status).toBe('abandoned');
    expect(await x.phase()).toBe('abandoned');
    expect(await shAsync(x.repo.path, ['rev-parse', 'main'])).toBe(base);
  });

  it('batches: Reject is refused while a Merge is in flight', async () => {
    const g = gatedMerge();
    const x = setup(undefined, 3, { provider: g.provider });
    await batchInReview(x);
    const merging = x.lc.mergeBatch('r1-b1');
    await g.entered;
    await expect(x.lc.rejectBatch('r1-b1', 'not yet')).rejects.toThrow('batch r1-b1 is being merged');
    expect(x.db.batches.get('r1-b1')?.status).toBe('review'); // the reject did not move it
    g.open();
    await merging;
    expect(x.db.batches.get('r1-b1')?.status).toBe('merged');
  });

  it('batches: a terminal action is allowed again once the one in flight has ended', async () => {
    const x = setup();
    await batchInReview(x);
    // Hold the reject after it moved the batch back to open, so an abandon meanwhile is refused by the guard, not by the state.
    const held = holdRetrospective(x.lc);
    try {
      const rejecting = x.lc.rejectBatch('r1-b1', 'next round');
      await held.entered;
      expect(x.db.batches.get('r1-b1')?.status).toBe('open');
      await expect(x.lc.abandonBatch('r1-b1')).rejects.toThrow('batch r1-b1 is being rejected');
      held.open();
      await rejecting;
    } finally {
      held.restore();
    }
    // The first action ended: the abandon is allowed again and now really runs.
    await x.lc.abandonBatch('r1-b1');
    expect(x.db.batches.get('r1-b1')?.status).toBe('abandoned');
  });

  it('batches: a Merge that fails on a conflict releases the guard, so the next action runs', async () => {
    const g = gatedMerge(true);
    const x = setup(undefined, 3, { provider: g.provider });
    await batchInReview(x);
    const merging = x.lc.mergeBatch('r1-b1');
    await g.entered;
    await expect(x.lc.rejectBatch('r1-b1', 'not yet')).rejects.toThrow('batch r1-b1 is being merged');
    g.open();
    await expect(merging).rejects.toBeInstanceOf(MergeConflictError);
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', conflict_files: ['README.md'] });
    await x.lc.rejectBatch('r1-b1', 'rebase onto main');
    expect(x.db.batches.get('r1-b1')?.status).toBe('open');
  });

  it('batches: short worktree paths and slugs keep Windows paths under the limit', () => {
    expect(batchWorktreePath('W', 'overseer-copy', 'overseer-copy-b1')).toBe(path.join('W', 'overseer-copy', 'b1'));
    expect(batchWorktreePath('W', 'r1', 'other-b2')).toBe(path.join('W', 'r1', 'other-b2'));
    expect(slug('Add ui-check-1.txt containing the word one, then wait two minutes before doing it')).toBe('add-ui-check-1-txt-containing-the-word-o');
    expect(slug('x'.repeat(100))).toHaveLength(SLUG_MAX);
    expect(slug('!!!')).toBe('batch');
  });

  it('batches: a worktree that cannot be created rolls the branch back and tells the user', async () => {
    const x = setup();
    const wtPath = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1');
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    fs.writeFileSync(wtPath, 'not a directory');
    await expect(x.lc.createBatch('r1', 'Blocked path')).rejects.toThrow(/could not create the batch worktree/);
    expect(await shAsync(x.repo.path, ['branch', '--list', 'feature/blocked-path'])).toBe('');
    expect(x.db.batches.all()).toHaveLength(0);
    expect(x.notes.at(-1)).toMatch(/^Batch creation failed for r1: git could not create the worktree at .*feature\/blocked-path was removed/);
  });

  it('batches: a local-merge branch is cut from the local base when it is ahead of origin', async () => {
    const x = setup();
    const bare = path.join(path.dirname(x.repo.path), 'origin.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    const localMain = await commitFileAsync(x.repo.path, 'local.txt', 'merged locally\n', 'local commit');
    const b = await x.lc.createBatch('r1', 'Local base');
    expect(b.warning).toBeUndefined();
    expect(await shAsync(x.repo.path, ['rev-parse', 'feature/local-base'])).toBe(localMain);
    expect(await shAsync(x.repo.path, ['rev-parse', 'origin/main'])).not.toBe(localMain);
  });

  it('batches: a local-merge branch stays on the local base when origin has commits it lacks, and warns with the count', async () => {
    const x = setup();
    const bare = path.join(path.dirname(x.repo.path), 'origin.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    const other = path.join(path.dirname(x.repo.path), 'other');
    await shAsync(x.repo.path, ['clone', '-q', bare, other]);
    await commitFileAsync(other, 'a.txt', 'a\n', 'remote a');
    const ahead = await commitFileAsync(other, 'b.txt', 'b\n', 'remote b');
    await shAsync(other, ['push', '-q', 'origin', 'main']);
    const localMain = await shAsync(x.repo.path, ['rev-parse', 'main']);
    const warn = scopedSpy(console, 'warn').mockImplementation(() => {});
    try {
      const b = await x.lc.createBatch('r1', 'Behind origin');
      expect(b.warning).toMatch(/^origin\/main has 2 commits that the local main lacks; the branch was cut from the local main/);
      expect(warn.mock.calls[0]?.[0]).toMatch(/origin\/main has 2 commits/);
    } finally {
      warn.mockRestore();
    }
    expect(await shAsync(x.repo.path, ['rev-parse', 'feature/behind-origin'])).toBe(localMain);
    expect(await shAsync(x.repo.path, ['rev-parse', 'main'])).toBe(localMain);
    expect(await shAsync(x.repo.path, ['rev-parse', 'origin/main'])).toBe(ahead);
  });

  it('batches: a local-merge branch warns about a failed fetch and counts against the stale origin ref as such', async () => {
    const x = setup();
    const bare = path.join(path.dirname(x.repo.path), 'origin.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    const other = path.join(path.dirname(x.repo.path), 'other');
    await shAsync(x.repo.path, ['clone', '-q', bare, other]);
    await commitFileAsync(other, 'a.txt', 'a\n', 'remote a');
    await shAsync(other, ['push', '-q', 'origin', 'main']);
    await shAsync(x.repo.path, ['fetch', '-q', 'origin', 'main']);
    await shAsync(x.repo.path, ['remote', 'set-url', 'origin', path.join(path.dirname(x.repo.path), 'missing.git')]);
    const localMain = await shAsync(x.repo.path, ['rev-parse', 'main']);
    const warn = scopedSpy(console, 'warn').mockImplementation(() => {});
    try {
      const b = await x.lc.createBatch('r1', 'Stale one');
      expect(b.warning).toMatch(/^could not fetch origin\/main; the branch was cut from the local main\. The last fetched origin\/main, which may be behind the remote, has 1 commit that the local main lacks; nothing was merged or fast-forwarded: /);
      // Zero missing commits in the stale ref still reports the failed fetch.
      await shAsync(x.repo.path, ['merge', '-q', '--ff-only', 'origin/main']);
      const c = await x.lc.createBatch('r1', 'Stale two');
      expect(c.warning).toMatch(/^could not fetch origin\/main; the branch was cut from the local main: /);
      expect(c.warning).not.toMatch(/commit/);
    } finally {
      warn.mockRestore();
    }
    expect(await shAsync(x.repo.path, ['rev-parse', 'feature/stale-one'])).toBe(localMain);
  });

  it('batches: a gitlab-mr branch is cut from the fetched origin base, not the stale local one', async () => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    // origin: a bare clone that a second checkout then advances, so the local main is one commit behind origin/main.
    const bare = path.join(path.dirname(x.repo.path), 'origin.git');
    await shAsync(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    const other = path.join(path.dirname(x.repo.path), 'other');
    await shAsync(x.repo.path, ['clone', '-q', bare, other]);
    const ahead = await commitFileAsync(other, 'remote.txt', 'from origin\n', 'remote commit');
    await shAsync(other, ['push', '-q', 'origin', 'main']);
    const localMain = await shAsync(x.repo.path, ['rev-parse', 'main']);
    expect(localMain).not.toBe(ahead);
    const b = await x.lc.createBatch('r1', 'Fresh base');
    expect(b.warning).toBeUndefined();
    expect(await shAsync(x.repo.path, ['rev-parse', 'feature/fresh-base'])).toBe(ahead);
    expect(await shAsync(x.repo.path, ['rev-parse', 'main'])).toBe(localMain);
  });

  vitestIt.each([
    ['without a base', undefined],
    ['with the repo base', '  main  '],
    ['with a blank base', '   '],
  ] as const)('batches: %s keeps the configured base behavior', async (_label, base) => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    const origin = await addBareOrigin(x.repo.path);
    const other = path.join(path.dirname(x.repo.path), 'other');
    await shAsync(x.repo.path, ['clone', '-q', origin, other]);
    const remoteMain = await commitFileAsync(other, 'remote.txt', 'from origin\n', 'remote commit');
    await shAsync(other, ['push', '-q', 'origin', 'main']);

    const branch = `feature/configured-base-${base?.trim() ? 'explicit' : 'default'}-${_label.replaceAll(' ', '-')}`;
    const batch = await x.lc.createBatch('r1', 'Configured base', branch, null, base);
    expect(await shAsync(x.repo.path, ['rev-parse', branch])).toBe(remoteMain);
    expect(batch.base_branch).toBe('main');
  });

  vitestIt.each(['open', 'review'] as const)('batches: a %s GitLab batch is a local stack base, including unpushed commits', async (status) => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    await addBareOrigin(x.repo.path);
    const parent = await x.lc.createBatch('r1', `Parent ${status}`);
    const unpushed = await commitFileAsync(batchWorktreePath(x.worktreesDir, 'r1', parent.id), 'stacked.txt', `${status}\n`, 'unpushed base commit');
    x.db.batches.update(parent.id, { status });

    const base = status === 'open' ? `  ${parent.branch}  ` : parent.branch;
    const stacked = await x.lc.createBatch('r1', `Stacked ${status}`, `feature/stacked-${status}`, null, base);
    expect(await shAsync(x.repo.path, ['rev-parse', stacked.branch])).toBe(unpushed);
    expect(stacked.base_branch).toBe(parent.branch);
  });

  it('batches: a local-merge repo refuses a different base before creating a row or branch', async () => {
    const x = setup();
    await expect(x.lc.createBatch('r1', 'Unsupported stack', 'feature/unsupported-stack', null, 'topic'))
      .rejects.toThrow(/repo r1 uses merge mode local-merge; stacking on another branch is only supported for gitlab-mr repositories/);
    expect(await shAsync(x.repo.path, ['branch', '--list', 'feature/unsupported-stack'])).toBe('');
    expect(x.db.batches.all()).toHaveLength(0);
  });

  it('batches: a new branch cannot also be its own stack base', async () => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    const branch = 'feature/self-base';
    await expect(x.lc.createBatch('r1', 'Self base', branch, null, branch))
      .rejects.toThrow(/base branch feature\/self-base cannot be the new batch branch feature\/self-base/);
    expect(await shAsync(x.repo.path, ['branch', '--list', branch])).toBe('');
    expect(x.db.batches.all()).toHaveLength(0);
  });

  it('batches: an origin-only stack base is fetched, trimmed, and stored', async () => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    const origin = await addBareOrigin(x.repo.path);
    const other = path.join(path.dirname(x.repo.path), 'other');
    await shAsync(x.repo.path, ['clone', '-q', origin, other]);
    await shAsync(other, ['switch', '-q', '-c', 'origin-only']);
    const remoteHead = await commitFileAsync(other, 'origin-only.txt', 'remote\n', 'origin-only base');
    await shAsync(other, ['push', '-q', 'origin', 'origin-only']);

    const batch = await x.lc.createBatch('r1', 'Origin only', 'feature/origin-only-child', null, '  origin-only  ');
    expect(await shAsync(x.repo.path, ['rev-parse', batch.branch])).toBe(remoteHead);
    expect(batch.base_branch).toBe('origin-only');
  });

  it('batches: a branch absent from origin is refused without creating a row or branch', async () => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    await addBareOrigin(x.repo.path);
    const branch = 'feature/missing-origin-child';
    await expect(x.lc.createBatch('r1', 'Missing origin', branch, null, 'missing-stack'))
      .rejects.toThrow(/base branch missing-stack is unavailable on origin/);
    expect(await shAsync(x.repo.path, ['branch', '--list', branch])).toBe('');
    expect(x.db.batches.all()).toHaveLength(0);
  });

  it('batches: a local-only branch that is not an active batch is refused', async () => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    await addBareOrigin(x.repo.path);
    await shAsync(x.repo.path, ['branch', 'local-only', 'main']);
    const branch = 'feature/local-only-child';
    await expect(x.lc.createBatch('r1', 'Local only', branch, null, 'local-only'))
      .rejects.toThrow(/base branch local-only is unavailable on origin/);
    expect(await shAsync(x.repo.path, ['branch', '--list', branch])).toBe('');
    expect(x.db.batches.all()).toHaveLength(0);
  });

  it('batches: a failed fetch refuses a stale origin ref', async () => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    const origin = await addBareOrigin(x.repo.path);
    const other = path.join(path.dirname(x.repo.path), 'other');
    await shAsync(x.repo.path, ['clone', '-q', origin, other]);
    await shAsync(other, ['switch', '-q', '-c', 'stale-origin']);
    await commitFileAsync(other, 'stale.txt', 'remote\n', 'origin base');
    await shAsync(other, ['push', '-q', 'origin', 'stale-origin']);
    await shAsync(x.repo.path, ['fetch', '-q', 'origin', 'stale-origin']);
    await shAsync(x.repo.path, ['remote', 'set-url', 'origin', path.join(path.dirname(x.repo.path), 'missing.git')]);

    const branch = 'feature/stale-origin-child';
    await expect(x.lc.createBatch('r1', 'Stale origin', branch, null, 'stale-origin'))
      .rejects.toThrow(/base branch stale-origin is unavailable on origin: .*could not fetch origin\/stale-origin/);
    expect(await shAsync(x.repo.path, ['branch', '--list', branch])).toBe('');
    expect(x.db.batches.all()).toHaveLength(0);
  });

  vitestIt.each(['merged', 'abandoned'] as const)('batches: a %s batch branch deleted from origin cannot be used as a stack base', async (status) => {
    const x = setup(undefined, undefined, { mergeMode: 'gitlab-mr' });
    await addBareOrigin(x.repo.path);
    const parent = await x.lc.createBatch('r1', `Finished ${status}`);
    await shAsync(x.repo.path, ['push', '-q', 'origin', parent.branch]);
    x.db.batches.update(parent.id, { status });
    await shAsync(x.repo.path, ['push', '-q', 'origin', '--delete', parent.branch]);

    const branch = `feature/deleted-${status}-child`;
    await expect(x.lc.createBatch('r1', `Deleted ${status}`, branch, null, parent.branch))
      .rejects.toThrow(new RegExp(`base branch ${parent.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is unavailable on origin`));
    expect(await shAsync(x.repo.path, ['branch', '--list', branch])).toBe('');
    expect(x.db.batches.all()).toHaveLength(1);
  });

  it('batches: a failed fetch falls back to the local base and warns', async () => {
    const x = setup();
    await shAsync(x.repo.path, ['remote', 'add', 'origin', path.join(path.dirname(x.repo.path), 'missing.git')]);
    const localMain = await shAsync(x.repo.path, ['rev-parse', 'main']);
    const warn = scopedSpy(console, 'warn').mockImplementation(() => {});
    try {
      const b = await x.lc.createBatch('r1', 'Offline');
      expect(b.warning).toMatch(/^could not fetch origin\/main; the branch was cut from the local main/);
      expect(warn.mock.calls[0]?.[0]).toMatch(/could not fetch origin\/main/);
    } finally {
      warn.mockRestore();
    }
    expect(await shAsync(x.repo.path, ['rev-parse', 'feature/offline'])).toBe(localMain);
  });

  it('batches: verification failure reopens the bead without user review', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Fails');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && (await x.phase()) === null, WAIT, 'reopened');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Verification failed');
    // The notice names the command that ran, so the orchestrator quotes it instead of guessing from bead notes (round 7).
    expect(x.notes.at(-1)).toMatch(/^ov-1 reopened: the verify command `node -e "process.exit\(1\)"` failed on bead\/ov-1\.\n/);
    expect(x.hints.at(-1)).toMatch(/Retry verification/); // the guidance reaches the model, not the thread (round 8)
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'n')).rejects.toThrow(/still open/);
  });

  it('batches: the board card carries the failed verification, Retry verification integrates once the command passes', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Retry');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    const card = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(card.column).toBe('ready');
    expect(card.verify_failure).toMatch(/exit 1$/);
    // The command was wrong, not the work: fix it in the repo settings and verify again without a new worker.
    x.db.repos.update('r1', { verify_command: `node -e "setTimeout(()=>process.exit(0), 300)"` });
    // Two clicks in the same moment: exactly one starts the run, the other is refused (which one wins depends on git's timing).
    const clicks = await Promise.allSettled([x.lc.reverify('ov-1'), x.lc.reverify('ov-1')]);
    expect(clicks.map((c) => c.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((clicks.find((c) => c.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/being verified/);
    expect(await x.phase()).toBe('verifying');
    await expect(x.lc.reverify('ov-1')).rejects.toThrow(/being verified/);
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow(/being verified/); // no worker in a worktree being integrated
    await expect(x.lc.redispatch('ov-1')).rejects.toThrow(/being verified/);
    await until(() => /landed/.test(x.notes.at(-1) ?? ''), WAIT, 'landed');
    expect(x.wakes.at(-1)).toBe(x.notes.at(-1)); // the batch is complete: the orchestrator has to request review
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ verify_status: 'pass', merged_at: expect.any(String) });
    expect(x.notes.at(-1)).toMatch(/^ov-1 landed on feature\/retry/);
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1); // no worker ran
    await expect(x.lc.reverify('ov-1')).rejects.toThrow(/worktree of ov-1 is gone/); // landed: its worktree was removed
    await expect(x.lc.reverify('ov-9')).rejects.toThrow(/no worktree/);
  });

  it('batches: Retry verification that fails again reopens the bead; Re-dispatch starts a worker with the output', async () => {
    const x = setup(`node -e "console.log('boom'); process.exit(1)"`);
    await x.lc.createBatch('r1', 'Again');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await expect(x.lc.reverify('ov-1')).rejects.toThrow(/running worker/);
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    const before = x.notes.length;
    await x.lc.reverify('ov-1');
    await until(() => x.notes.length > before, WAIT, 'verified again');
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBeNull();
    expect(x.notes.at(-1)!.startsWith('ov-1 reopened: the verify command `node -e "console.log(\'boom\'); process.exit(1)"` failed on bead/ov-1')).toBe(true);
    const sid2 = await x.lc.redispatch('ov-1');
    expect(sid2).not.toBe(sid);
    const prompt = x.fake.sent(x.sessions.handleOf(sid2)!)[0]!;
    expect(prompt).toContain('verification failed');
    expect(prompt).toContain('boom');
    // The failure stays on the row through the re-dispatch: it is the state of the branch this worker starts on (round 21 R21-1).
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ batch_id: 'r1-b1', verify_status: 'fail' });
    expect(await x.status()).toBe('in_progress');
    expect(x.notes.at(-1)).toBe('ov-1 re-dispatched to claude by the user from the Board with the failed verification output.');
    expect(x.hints.at(-1)).toBe('Do not dispatch it again.');
    await expect(x.lc.redispatch('ov-1')).rejects.toThrow(/already has a running session/);
  });

  it('batches: a re-dispatched worker that adds no commit to a branch that has some triggers verification, not a reopen', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Again');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    const sid2 = await x.lc.redispatch('ov-1');
    // The user fixes the command meanwhile; the second worker finds the tree correct and commits nothing.
    x.db.repos.update('r1', { verify_command: `node -e "process.exit(0)"` });
    x.fake.emit(x.sessions.handleOf(sid2)!, { type: 'assistant_text', text: 'The task is already done and correct.' });
    x.finishTurn(sid2);
    await until(() => /landed/.test(x.notes.at(-1) ?? ''), WAIT, 'landed');
    expect(await x.status()).toBe('closed');
    expect(x.db.sessions.get(sid2)?.status).toBe('ended'); // not "failed": the worker did its job
    expect(x.notes.some((n) => /ended without commits/.test(n))).toBe(false);
  });

  it('batches: a re-dispatch merges commits that landed on the batch branch since the branch was cut', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Tip');
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    // The first attempt commits nothing: it reopens on the branch it was cut from, which stays.
    x.finishTurn(first);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    // A sibling bead's capability lands on the batch branch while this bead is parked.
    const capability = await commitFileAsync(batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1'), 'capability.txt', 'locked\n', 'add capability');

    const second = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    expect(second).toEqual(expect.any(String));
    expect(fs.existsSync(path.join(wt.path, 'capability.txt'))).toBe(true);
    expect(await shAsync(wt.path, ['merge-base', '--is-ancestor', capability, 'HEAD'])).toBe(''); // the batch commit is in the new worker's tree
  });

  it('batches: a re-dispatch whose batch branch conflicts reopens without a worker, and the next one resolves it', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Clash');
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'README.md', '# bead\n', 'bead side');
    x.finishTurn(first);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    // The batch branch moved on the same file while the bead was parked: the merge-in cannot start the worker.
    await commitFileAsync(batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1'), 'README.md', '# batch\n', 'batch side');

    await expect(x.lc.redispatch('ov-1')).rejects.toBeInstanceOf(LifecycleError);
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBeNull();
    expect(x.db.worktrees.get('ov-1')?.conflict_files).toEqual(['README.md']);
    expect(x.notes.at(-1)).toMatch(/was not dispatched: merging feature\/clash into bead\/ov-1 conflicted in: README\.md.*next worker is started to rebase/);
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1); // no new session was started

    // The supported recovery: the re-dispatch after the recorded conflict starts the worker whose prompt is that conflict to resolve.
    const recovery = await x.lc.redispatch('ov-1');
    const prompt = x.fake.sent(x.sessions.handleOf(recovery)!)[0]!;
    expect(prompt).toContain('Rebase this branch onto `feature/clash`');
    expect(prompt).toContain('- README.md');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(2);
  });

  it('batches: a retried verification that throws reopens the bead with the reason instead of parking it in Verifying', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Throws');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    const update = x.store.update.bind(x.store);
    const spy = vi.spyOn(x.store, 'update').mockImplementation(async (repoPath, id, patch) => {
      if (patch.phase === 'verifying') { spy.mockRestore(); throw new Error('bd is locked'); }
      return update(repoPath, id, patch);
    });
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    await x.lc.reverify('ov-1');
    await until(() => /retry failed/.test(x.notes.at(-1) ?? ''), WAIT, 'reopened after the failed retry');
    expect(error.mock.calls.some((c) => /re-verification of ov-1 failed/.test(String(c[0])))).toBe(true);
    error.mockRestore();
    expect(x.notes.at(-1)).toBe('ov-1 reopened: the verification retry failed: bd is locked');
    expect(x.wakes.at(-1)).toBe(x.notes.at(-1));
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Verification retry failed: bd is locked');
    await x.lc.reverify('ov-1'); // the guard was released
  });

  it('batches: integration conflict reopens the bead with conflict files', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Clash');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'README.md', '# bead\n', 'bead side');
    await commitFileAsync(batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1'), 'README.md', '# batch\n', 'batch side');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    expect(x.db.worktrees.get('ov-1')?.conflict_files).toEqual(['README.md']);
    expect(x.notes.at(-1)).toMatch(/conflicted in: README.md/);

    // The recorded conflict is resolved by the next worker, not by retrying the merge-in: the re-dispatch reaches the prompt.
    const recovery = await x.lc.redispatch('ov-1');
    const prompt = x.fake.sent(x.sessions.handleOf(recovery)!)[0]!;
    expect(prompt).toContain('- README.md');
    expect(prompt).toContain('Rebase this branch onto `feature/clash`');
  });

  it('batches: reject, abandon and interrupt', async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Second' });
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Third' });
    await x.lc.createBatch('r1', 'Two beads');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    expect(await x.status()).toBe('closed');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'first pass');
    const proof = Buffer.from('batch proof');
    await x.lc.rejectBatch('r1-b1', 'needs the second file', [{ name: 'batch.png', mime: 'image/png', data: proof }]);
    const stored = x.storedAttachments.filter((attachments) => attachments.length > 0).at(-1)![0]!;
    expect(path.isAbsolute(stored.path)).toBe(true);
    expect(fs.readFileSync(stored.path)).toEqual(proof);
    // The summary is the current round only; the rejected one and the note become history (round 13: the pane opened with the previous round's summary).
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'open', note: null, history: `first pass\n\nRejected: needs the second file\nAttachment: ${stored.path}` });
    // The retrospective notice follows a rejection or an abandon (retrospective.test.ts covers it); the batch notice is the one before it.
    const last = () => x.notes.filter((n) => !n.startsWith('Retrospective ready')).at(-1);
    expect(last()).toBe('Batch r1-b1 rejected: needs the second file');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'second pass');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ note: 'second pass', history: `first pass\n\nRejected: needs the second file\nAttachment: ${stored.path}` });
    await x.lc.rejectBatch('r1-b1', 'still missing');
    expect(x.db.batches.get('r1-b1')?.history).toBe(`first pass\n\nRejected: needs the second file\nAttachment: ${stored.path}\n\nsecond pass\n\nRejected: still missing`);

    const sid2 = await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b1' });
    const h2 = x.sessions.handleOf(sid2)!;
    await expect(x.lc.interruptBead('ov-1')).rejects.toBeInstanceOf(LifecycleError);
    x.store.add(x.repo.path, { id: 'ov-8', title: 'Created for the batch, never dispatched', labels: ['overseer:batch:r1-b1'] });
    await x.lc.abandonBatch('r1-b1');
    await until(() => x.db.sessions.get(sid2)?.status !== 'running', WAIT, 'worker stopped');
    expect(x.fake.sessions.get(h2.id)?.interrupted).toBe(true);
    expect(await x.status('ov-2')).toBe('closed');
    expect(await x.phase('ov-2')).toBe('abandoned');
    expect(await x.phase('ov-1')).toBe('abandoned'); // had landed on the branch that is now gone
    expect([await x.status('ov-8'), await x.phase('ov-8')]).toEqual(['closed', 'abandoned']); // the never-dispatched bead of the batch goes with it (round 15)
    expect(x.db.batches.get('r1-b1')?.status).toBe('abandoned');
    expect(await shAsync(x.repo.path, ['branch', '--list', 'feature/two-beads'])).toBe('');
    expect(x.db.worktrees.forBatch('r1-b1').map((w) => [w.bead_id, fs.existsSync(w.path)])).toEqual([['ov-1', false], ['ov-2', false]]);
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[0]).toMatchObject({ status: 'abandoned', beads_total: 3, beads_done: 1 });
    expect(last()).toBe('Batch r1-b1 abandoned by the user');

    const sid3 = await x.lc.spawnWorker('r1', 'ov-3', { harness: 'claude' });
    await x.lc.interruptBead('ov-3');
    await until(() => x.db.sessions.get(sid3)?.status !== 'running', WAIT, 'interrupted');
    await until(async () => (await x.status('ov-3')) === 'open', WAIT, 'reopened after stop');
    expect(x.db.sessions.get(sid3)?.status).toBe('ended');
    // The stop is recorded in the session's own events, so its trace ends with a stop rather than "the process exited" (round 13).
    expect(x.db.events.forSession(sid3).at(-1)).toMatchObject({ type: 'interrupt', payload: { by: 'user' } });
    expect(await x.phase('ov-3')).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-3'))?.notes).toContain('Stopped by the user from the Board');
    // The thread row is the log line; the instruction to the model travels as a hint (round 8: it read as an order in the thread).
    expect(x.notes.at(-1)).toBe('ov-3 stopped by the user from the Board; reopened without new commits.');
    expect(x.hints.at(-1)).toBe('Do not re-dispatch it unless the user asks.');

    // A stop the orchestrator made on the user's instruction (interrupt_worker) is a stop too, not a failure whose "reason" is the worker's last sentence (round 9).
    const sid4 = await x.lc.spawnWorker('r1', 'ov-3', { harness: 'claude' });
    x.fake.emit(x.sessions.handleOf(sid4)!, { type: 'assistant_text', text: "I'll load the skill, then make the change." });
    // The model's reason ends in a full stop; the note and the notice join on it without a ".;" or ". (" (round 10).
    await x.lc.interruptBead('ov-3', { by: 'orchestrator', reason: 'The user asked not to dispatch this fix.' });
    await until(() => x.db.sessions.get(sid4)?.status !== 'running', WAIT, 'interrupted by the orchestrator');
    await until(async () => (await x.status('ov-3')) === 'open', WAIT, 'reopened after the orchestrator stop');
    expect(x.db.sessions.get(sid4)?.status).toBe('ended');
    const notes = (await x.store.show(x.repo.path, 'ov-3'))?.notes ?? '';
    expect(notes).toContain(`Stopped by the orchestrator: The user asked not to dispatch this fix (worker session ${sid4}, no new commits)`);
    expect(notes).not.toContain('ended without new commits');
    expect(x.notes.at(-1)).toBe('ov-3 stopped by the orchestrator: The user asked not to dispatch this fix; reopened without new commits.');
    expect(x.hints.at(-1)).toBe('You interrupted this worker; do not re-dispatch it unless the user asks.');
  });

  it('batches: Close bead on a stopped bead keeps the batch open, counts it as closed, and request review then succeeds (round 13)', async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Follow-up' });
    await x.lc.createBatch('r1', 'Two beads');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    // The follow-up is dispatched, then stopped on the user's instruction; nothing landed for it.
    const sid2 = await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b1' });
    await expect(x.lc.closeBead('ov-2')).rejects.toThrow(/busy/); // a live worker: not closable from under it
    await x.lc.interruptBead('ov-2', { by: 'orchestrator', reason: 'The user changed their mind.' });
    await until(async () => (await x.status('ov-2')) === 'open', WAIT, 'reopened after stop');
    expect(x.db.events.forSession(sid2).some((e) => e.type === 'interrupt' && (e.payload as { by: string }).by === 'orchestrator')).toBe(true);
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'one bead')).rejects.toThrow(/ov-2 not done/);
    const wt2 = x.db.worktrees.get('ov-2')!;
    expect(fs.existsSync(wt2.path)).toBe(true);
    // A bead that waited on the closed one becomes ready in bd; the orchestrator must hear which, and ask before dispatching it (fix round 13 review).
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Tests for the follow-up' }, ['ov-2']);
    // One that waits on another open bead too is not ready after the close, and the notice must not say it is (fix round 14 review).
    x.store.add(x.repo.path, { id: 'ov-9', title: 'Other blocker' });
    x.store.add(x.repo.path, { id: 'ov-5', title: 'Waits on two' }, ['ov-2', 'ov-9']);
    // Created for the batch (labelled at creation) and never dispatched: it counts for the batch from now on (round 15).
    x.store.add(x.repo.path, { id: 'ov-6', title: 'Created, not dispatched', labels: ['overseer:batch:r1-b1'] });

    await x.lc.closeBead('ov-2', 'Not needed after all');
    expect(await x.status('ov-2')).toBe('closed');
    expect(await x.phase('ov-2')).toBe('closed');
    expect((await x.store.show(x.repo.path, 'ov-2'))?.notes).toContain("won't do (closed by the user from the Board: Not needed after all)");
    expect(fs.existsSync(wt2.path)).toBe(false);
    expect(await shAsync(x.repo.path, ['branch', '--list', 'bead/ov-2'])).toBe('');
    expect(x.db.worktrees.get('ov-2')).toMatchObject({ batch_id: 'r1-b1', merged_at: null, closed_at: expect.any(String) });
    expect(x.db.batches.get('r1-b1')?.status).toBe('open');
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[0]).toMatchObject({ beads_total: 3, beads_done: 1, beads_closed: 1 });
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board: Not needed after all; batch r1-b1 stays open (1/3 beads done, 1 closed); ov-4 waited on it and is ready in bd now; ov-5 waited on it and is still blocked by other beads.");
    expect(x.wakes.at(-1)).toBe(x.notes.at(-1)); // nothing else runs in the batch: the orchestrator has to request review
    expect(x.hints.at(-1)).toBe('Do not re-dispatch it. ov-4, ov-5 depended on it: ask the user before dispatching any of them. When every remaining bead of the batch has landed or been closed, call request_batch_review.');
    expect(await x.store.ready(x.repo.path)).toContain('ov-4');
    await expect(x.lc.closeBead('ov-2')).rejects.toThrow(/already closed/);

    // The labelled, never-dispatched bead is part of the batch: review cannot be requested over it, and closing it from its card counts it as closed.
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'one bead')).rejects.toThrow(/ov-6 not done/);
    await x.lc.closeBead('ov-6');
    expect(await x.phase('ov-6')).toBe('closed');
    expect(x.notes.at(-1)).toBe("ov-6 closed as won't do by the user from the Board; batch r1-b1 stays open (1/3 beads done, 2 closed).");
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[0]).toMatchObject({ beads_total: 3, beads_done: 1, beads_closed: 2 });
    await x.lc.requestBatchReview('r1', 'r1-b1', 'one bead landed, the follow-up was dropped');
    expect(x.db.batches.get('r1-b1')?.status).toBe('review');
    // A bead that was never dispatched (no worktree row) closes too; with no batch there is nothing for the orchestrator to do.
    // A failing `bd blocked` does not fail the close; the notice says the dependents are unknown (fix round 14 review).
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Never started' });
    vi.spyOn(x.store, 'blocked').mockRejectedValueOnce(new Error('bd blocked failed: locked'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    await x.lc.closeBead('ov-3');
    expect(error.mock.calls[0]?.[0]).toBe('lifecycle: bd blocked failed before a close');
    error.mockRestore();
    expect(await x.status('ov-3')).toBe('closed');
    expect(x.notes.at(-1)).toBe("ov-3 closed as won't do by the user from the Board; its dependents could not be read (bd blocked failed).");
    expect(x.hints.at(-1)).toBe('Do not re-dispatch it.');
    expect(x.wakes.at(-1)).not.toBe(x.notes.at(-1));
    await expect(x.lc.closeBead('ov-nope')).rejects.toThrow(/not found/);
  });

  it('batches: createBatch refuses a branch that already exists in git', async () => {
    const x = setup();
    await shAsync(x.repo.path, ['branch', 'feature/pre-existing']);
    await expect(x.lc.createBatch('r1', 'Pre existing')).rejects.toThrow(/already exists/);
    expect(x.db.batches.all()).toHaveLength(0);
  });

  /**
   * Lands one bead that writes `file` in a fresh batch of `x` and requests its review; the batch ids follow creation order (r1-b1, r1-b2, …).
   * Two batches that write the same file with the same `content` overlap without conflicting; different content conflicts once one of them merges.
   */
  async function reviewedBatch(x: ReturnType<typeof setup>, n: number, file: string, content = 'same\n') {
    const id = await landedBatch(x, n, file, content);
    await x.lc.requestBatchReview('r1', id, `Adds ${file}`);
    return id;
  }

  /** Lands and reviews a batch cut from an explicit base branch. */
  async function reviewedBatchOnBase(x: ReturnType<typeof setup>, n: number, file: string, base: string, branch: string, content = 'same\n') {
    const batch = await landedBatchOnBase(x, n, file, base, branch, content);
    await x.lc.requestBatchReview('r1', batch.id, `Adds ${file}`);
    await shAsync(x.repo.path, ['push', '-q', 'origin', batch.branch]);
    return batch;
  }

  /** Lands one bead in a batch created from an explicit base branch. */
  async function landedBatchOnBase(x: ReturnType<typeof setup>, n: number, file: string, base: string, branch: string, content = 'same\n') {
    const beadId = `ov-${n}`;
    if (n > 1) x.store.add(x.repo.path, { id: beadId, title: `Bead ${n}`, description: `Write ${file}` });
    const batch = await x.lc.createBatch('r1', `Batch ${n}`, branch, null, base);
    const sid = await x.lc.spawnWorker('r1', beadId, { harness: 'claude', batchId: batch.id });
    await commitFileAsync(x.db.worktrees.get(beadId)!.path, file, content, `add ${file}`);
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.startsWith(`${beadId} landed on`) ?? false, WAIT, `${beadId} integrated`);
    return batch;
  }

  async function gitlabStackRepo(provider?: GitProvider) {
    const stackProvider = provider ?? { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider: stackProvider });
    await shAsync(x.repo.path, ['branch', 'dev', 'main']);
    await addBareOrigin(x.repo.path);
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'dev']);
    return x;
  }

  async function reviewedBranchAt(x: ReturnType<typeof setup>, title: string, branch: string, base: string, file: string, mrUrl: string | null = null, status: 'open' | 'review' = 'review') {
    const batch = await x.lc.createBatch('r1', title, branch, null, base);
    const wt = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    await commitFileAsync(wt, file, `${title}\n`, `add ${file}`);
    x.db.batches.update(batch.id, { status, mr_url: mrUrl });
    return x.db.batches.get(batch.id)!;
  }

  function mockMrProvider(targets: Map<string, string>, calls: string[][], updateError?: string) {
    const glab: GlabRunner = async (_cwd, args) => {
      calls.push(args);
      if (args[1] === 'view') return { code: 0, stdout: JSON.stringify({ target_branch: targets.get(args[2]!) }), stderr: '' };
      if (args[1] === 'update') {
        if (updateError) return { code: 1, stdout: '', stderr: updateError };
        targets.set(args[2]!, args[args.indexOf('--target-branch') + 1]!);
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return new GitlabMrProvider(glab);
  }

  async function landBatchBead(x: ReturnType<typeof setup>, batchId: string, n: number, file: string, content: string) {
    const beadId = `ov-${n}`;
    x.store.add(x.repo.path, { id: beadId, title: `Bead ${n}`, description: `Write ${file}` });
    const sid = await x.lc.spawnWorker('r1', beadId, { harness: 'claude', batchId });
    await commitFileAsync(x.db.worktrees.get(beadId)!.path, file, content, `update ${file}`);
    x.finishTurn(sid);
    await until(() => x.notes.some((note) => note.startsWith(`${beadId} landed on`)), WAIT, `${beadId} integrated`);
    return beadId;
  }

  /** `reviewedBatch` without the review request: the batch stays open with `file` landed on its branch. */
  async function landedBatch(x: ReturnType<typeof setup>, n: number, file: string, content = 'same\n') {
    const beadId = `ov-${n}`;
    if (n > 1) x.store.add(x.repo.path, { id: beadId, title: `Bead ${n}`, description: `Write ${file}` });
    const batch = await x.lc.createBatch('r1', `Batch ${n}`);
    const sid = await x.lc.spawnWorker('r1', beadId, { harness: 'claude', batchId: batch.id });
    await commitFileAsync(x.db.worktrees.get(beadId)!.path, file, content, `add ${file}`);
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.startsWith(`${beadId} landed on`) ?? false, WAIT, `${beadId} integrated`);
    return batch.id;
  }

  /**
   * Two batches cut from a local base that is behind origin, both merging the advanced origin base afterwards (2026-09-14:
   * acme-portal b5 "waited on" b2 over 100+ upstream files neither touched). Returns the overlap the second batch reports.
   */
  async function overlapBehindOrigin(x: ReturnType<typeof setup>, fileA: string, fileB: string) {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    const stale = await shAsync(x.repo.path, ['rev-parse', 'HEAD']);
    await landedBatch(x, 1, fileA);
    await landedBatch(x, 2, fileB);
    // Upstream moves on (file X) and the local base stays behind; both batches merge origin/main the way workers do.
    await commitFileAsync(x.repo.path, 'x.txt', 'upstream\n', 'release: x');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'main']);
    await shAsync(x.repo.path, ['reset', '-q', '--hard', stale]);
    for (const id of ['r1-b1', 'r1-b2']) {
      const wt = batchWorktreePath(x.worktreesDir, 'r1', id);
      await shAsync(wt, ['fetch', '-q', 'origin']);
      await shAsync(wt, ['merge', '-q', '--no-ff', '-m', 'merge origin/main', 'origin/main']);
    }
    await x.lc.requestBatchReview('r1', 'r1-b1', `Adds ${fileA}`);
    return x.lc.requestBatchReview('r1', 'r1-b2', `Adds ${fileB}`);
  }

  it('batches: the overlap check diffs each branch against the fresh remote base, so upstream commits both merged do not count', async () => {
    const x = setup();
    expect(await overlapBehindOrigin(x, 'a.txt', 'b.txt')).toMatchObject({ waitingOn: null, overlapFiles: null });
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: null, overlap_files: null });
    expect(x.notes.some((n) => n.includes('waiting on'))).toBe(false);
  });

  it('batches: the overlap check behind origin still reports exactly the file both batches change', async () => {
    const x = setup();
    expect(await overlapBehindOrigin(x, 'c.txt', 'c.txt')).toMatchObject({ waitingOn: 'r1-b1', overlapFiles: ['c.txt'] });
    expect(x.db.batches.get('r1-b2')).toMatchObject({ waiting_on: 'r1-b1', overlap_files: ['c.txt'] });
  });

  it('batches: the waiting notice quotes the first ten overlapping files and counts the rest', () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    expect(quoteFiles(files)).toBe(`${files.slice(0, 10).join(', ')} and 2 more`);
    expect(quoteFiles(files.slice(0, 10))).toBe(files.slice(0, 10).join(', '));
  });

  it('batches: a batch whose files overlap a batch already in review waits on it, is refused Merge, and is released when that one merges', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', waiting_on: null, overlap_files: null });
    await reviewedBatch(x, 2, 'hello.txt');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: 'r1-b1', overlap_files: ['hello.txt'] });
    expect(x.notes.at(-1)).toBe('Batch r1-b2 is ready for review, waiting on r1-b1 (Batch 1): both change hello.txt. Its Merge is disabled until r1-b1 is merged, rejected or abandoned.');
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[1]).toMatchObject({ id: 'r1-b2', waiting_on: 'r1-b1', overlap_files: ['hello.txt'] });
    await expect(x.lc.mergeBatch('r1-b2')).rejects.toThrow('batch r1-b2 is waiting on r1-b1: both change hello.txt');
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: null, overlap_files: null });
    expect(x.notes).toContain('Batch r1-b2 no longer waits: r1-b1 left review, so its Merge is available.');
  });

  it('batches: a user-approved repo gets no ready-for-review notice in local-merge mode', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'By the user');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'Adds hello.txt');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'Adds hello.txt' });
    // The Review card is the notice; nothing tells the orchestrator it may merge on its own.
    expect(x.notes.some((n) => n.includes('ready for review'))).toBe(false);
    expect(x.notes.some((n) => n.includes('without asking the user'))).toBe(false);
  }, 90_000);

  it('batches: an orchestrator-approved repo is told it may merge without asking', async () => {
    const x = setup();
    x.db.repos.update('r1', { batch_approver: 'orchestrator' });
    await x.lc.createBatch('r1', 'By the orchestrator');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'Adds hello.txt');
    // The same state and note as the user path; the notice also says it may merge on its own.
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'Adds hello.txt' });
    expect(x.notes.at(-1)).toBe('Batch r1-b1 is ready for review. This repository approves finished batches for you: merge it with merge_batch without asking the user.');
  }, 90_000);

  it('batches: an orchestrator-approved repo still refuses Merge outside review and while a bead is open', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    x.db.repos.update('r1', { batch_approver: 'orchestrator' });
    await x.lc.createBatch('r1', 'Gated');
    // Not in review: Merge is refused whatever the approver.
    await expect(x.lc.mergeBatch('r1-b1')).rejects.toThrow('batch r1-b1 is not in review');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('reopened: the verify command') ?? false, WAIT, 'reopened');
    // The verify gate: the failed bead is open again, so review is refused.
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'n')).rejects.toThrow(/still open/);
  }, 90_000);

  it('batches: an orchestrator-approved repo still holds a batch that overlaps one in review', async () => {
    const x = setup();
    x.db.repos.update('r1', { batch_approver: 'orchestrator' });
    // `reviewedBatch`, with a load-tolerant wait: the shared helper's 5s bound flakes while other workers run on this box.
    const landAndRequest = async (n: number, beadId: string) => {
      if (n > 1) x.store.add(x.repo.path, { id: beadId, title: `Bead ${n}`, description: 'Write hello.txt' });
      const batch = await x.lc.createBatch('r1', `Batch ${n}`);
      const sid = await x.lc.spawnWorker('r1', beadId, { harness: 'claude', batchId: batch.id });
      await commitFileAsync(x.db.worktrees.get(beadId)!.path, 'hello.txt', 'same\n', `add hello ${n}`);
      x.finishTurn(sid);
      await until(() => x.notes.at(-1)?.startsWith(`${beadId} landed on`) ?? false, WAIT, `${beadId} integrated`);
      await x.lc.requestBatchReview('r1', batch.id, `Adds hello.txt (${n})`);
    };
    await landAndRequest(1, 'ov-1');
    await landAndRequest(2, 'ov-2');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: 'r1-b1' });
    // The overlap hold survives the setting: the second batch waits on the first even though the orchestrator approves both.
    await expect(x.lc.mergeBatch('r1-b2')).rejects.toThrow('batch r1-b2 is waiting on r1-b1: both change hello.txt');
  }, 120_000);

  it('batches: the merge record follows who approved it on a local-merge repo', async () => {
    const x = setup();
    x.db.repos.update('r1', { batch_approver: 'orchestrator' });
    // `reviewedBatch`, with a load-tolerant wait: the shared helper's 5s bound flakes while other workers run on this box.
    const landAndRequest = async (n: number, beadId: string, file: string) => {
      if (n > 1) x.store.add(x.repo.path, { id: beadId, title: `Bead ${n}`, description: `Write ${file}` });
      const batch = await x.lc.createBatch('r1', `Batch ${n}`);
      const sid = await x.lc.spawnWorker('r1', beadId, { harness: 'claude', batchId: batch.id });
      await commitFileAsync(x.db.worktrees.get(beadId)!.path, file, 'x\n', `add ${file}`);
      x.finishTurn(sid);
      await until(() => x.notes.at(-1)?.startsWith(`${beadId} landed on`) ?? false, WAIT, `${beadId} integrated`);
      await x.lc.requestBatchReview('r1', batch.id, `Adds ${file}`);
    };
    await landAndRequest(1, 'ov-1', 'hello.txt');
    await x.lc.mergeBatch('r1-b1', 'orchestrator');
    expect(x.notes.at(-1)).toMatch(/^Batch r1-b1 merged into main \([0-9a-f]{7}\) by the orchestrator; feature\/batch-1 was deleted\.$/);
    // The user's own Merge on the same repository stays the user's.
    await landAndRequest(2, 'ov-2', 'bye.txt');
    await x.lc.mergeBatch('r1-b2');
    expect(x.notes.at(-1)).toMatch(/^Batch r1-b2 merged into main \([0-9a-f]{7}\) by the user; feature\/batch-2 was deleted\.$/);
  }, 150_000);

  it('batches: an invalid GitLab orchestrator value stays under user control', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true, mrUrl: 'https://gitlab.example.com/g/p/-/merge_requests/2' }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    // The API refuses this combination; a row edited out of band must still never merge an MR on the orchestrator's own initiative.
    x.db.repos.update('r1', { batch_approver: 'orchestrator' });
    const batch = await x.lc.createBatch('r1', 'Batch 1');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: batch.id });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add hello');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.startsWith('ov-1 landed on') ?? false, WAIT, 'ov-1 integrated');
    await x.lc.requestBatchReview('r1', batch.id, 'Adds hello.txt');
    expect(x.notes.some((note) => note.includes('without asking the user'))).toBe(false);
    await expect(x.lc.mergeBatch('r1-b1', 'orchestrator')).rejects.toThrow('batch r1-b1 must be merged by the user because this repository uses GitLab merge requests');
    expect(x.db.batches.get('r1-b1')?.status).toBe('review');
    await x.lc.mergeBatch('r1-b1');
    expect(x.notes.at(-1)).toBe('Batch r1-b1 marked merged (https://gitlab.example.com/g/p/-/merge_requests/2) by the user; feature/batch-1 was deleted.');
  }, 90_000);

  it('batches: merging a batch refreshes every other batch in review from base and verifies it again', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await x.lc.mergeBatch('r1-b1');
    const b2 = x.db.batches.get('r1-b2')!;
    expect(b2).toMatchObject({ status: 'review', conflict_files: null, refresh_from: null });
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(true);
    expect(await shAsync(wt, ['log', '-1', '--format=%s%n%n%b'])).toBe(`chore(batch-2): merge main\n\nRefresh ${b2.branch} from main after batch r1-b1 merged\nSource: main`);
    expect(x.notes).toContain('Batch r1-b2 refreshed from main after r1-b1; verify command `node -e "process.exit(0)"` passed');
    await x.lc.mergeBatch('r1-b2');
    expect(x.db.batches.get('r1-b2')?.status).toBe('merged');
  });

  it('batches: a bead landing refreshes a review batch stacked on its branch and skips other bases', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    const stacked = await reviewedBatchOnBase(x, 2, 'stacked.txt', parent.branch, 'feature/stacked', 'stacked\n');
    const unrelated = await reviewedBatchOnBase(x, 3, 'unrelated.txt', 'dev', 'feature/unrelated', 'unrelated\n');
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 4, 'parent-update.txt', 'updated parent\n');
    await until(() => x.notes.some((note) => note.startsWith(`Batch ${stacked.id} refreshed from ${parent.branch}`)), WAIT, 'stacked batch refresh');

    const parentHead = await shAsync(batchWorktreePath(x.worktreesDir, 'r1', parent.id), ['rev-parse', 'HEAD']);
    const stackedWt = batchWorktreePath(x.worktreesDir, 'r1', stacked.id);
    const includesParentHead = await shAsync(stackedWt, ['merge-base', '--is-ancestor', parentHead, 'HEAD']).then(() => true, () => false);
    const unrelatedRow = x.db.batches.get(unrelated.id)!;
    const unrelatedWt = batchWorktreePath(x.worktreesDir, 'r1', unrelated.id);
    expect({ includesParentHead, unrelatedHasParentUpdate: fs.existsSync(path.join(unrelatedWt, 'parent-update.txt')), unrelatedRefreshFrom: unrelatedRow.refresh_from }).toEqual({
      includesParentHead: true,
      unrelatedHasParentUpdate: false,
      unrelatedRefreshFrom: null,
    });
  });

  it('batches: an open batch stacked on a parent is not refreshed', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    const open = await landedBatchOnBase(x, 2, 'open-child.txt', parent.branch, 'feature/open-child', 'open child\n');
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 3, 'parent-update.txt', 'updated parent\n');

    const row = x.db.batches.get(open.id)!;
    const wt = batchWorktreePath(x.worktreesDir, 'r1', open.id);
    expect({ status: row.status, refreshFrom: row.refresh_from, hasParentUpdate: fs.existsSync(path.join(wt, 'parent-update.txt')) }).toEqual({
      status: 'open',
      refreshFrom: null,
      hasParentUpdate: false,
    });
  });

  it('batches: a stacked batch with a running worker defers its parent refresh until its next landing', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    const stacked = await reviewedBatchOnBase(x, 2, 'stacked.txt', parent.branch, 'feature/stacked', 'stacked\n');
    x.db.sessions.insert({ id: 's-busy-parent-stack', harness: 'claude', role: 'worker', bead_id: 'ov-2', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/wt', batch_id: stacked.id, log_path: null, log_offset: 0, tier: null, model: null, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null });
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 3, 'parent-update.txt', 'updated parent\n');
    await until(() => x.db.batches.get(stacked.id)?.refresh_from === parent.id, WAIT, 'parent refresh deferred');
    const deferred = x.db.batches.get(stacked.id)!;
    const parentHead = await shAsync(batchWorktreePath(x.worktreesDir, 'r1', parent.id), ['rev-parse', 'HEAD']);
    x.db.sessions.update('s-busy-parent-stack', { status: 'ended', ended_at: new Date().toISOString() });
    await x.lc.rejectBatch(stacked.id, 'Continue after the deferred refresh');
    await landBatchBead(x, stacked.id, 4, 'stacked-update.txt', 'updated child\n');
    await until(() => x.notes.some((note) => note.startsWith(`Batch ${stacked.id} refreshed from ${parent.branch}`)), WAIT, 'deferred parent refresh');

    const stackedWt = batchWorktreePath(x.worktreesDir, 'r1', stacked.id);
    expect({ deferredFrom: deferred.refresh_from, deferredHead: deferred.refresh_head, parentHead, hasParentUpdate: fs.existsSync(path.join(stackedWt, 'parent-update.txt')), hasChildUpdate: fs.existsSync(path.join(stackedWt, 'stacked-update.txt')) }).toEqual({
      deferredFrom: parent.id,
      deferredHead: parentHead,
      parentHead,
      hasParentUpdate: true,
      hasChildUpdate: true,
    });
  });

  it('batches: a conflicting parent commit names its branch in the refresh notice', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'collision.txt', 'dev', 'feature/parent', 'parent v1\n');
    const stacked = await reviewedBatchOnBase(x, 2, 'collision.txt', parent.branch, 'feature/stacked', 'stacked\n');
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 3, 'collision.txt', 'parent v2\n');
    await until(() => x.wakes.some((notice) => notice.includes(`could not be refreshed from ${parent.branch}`)), WAIT, 'stacked refresh conflict');

    expect(x.wakes.find((notice) => notice.startsWith(`Batch ${stacked.id} could not be refreshed`))).toContain(`from ${parent.branch}`);
  });

  it('batches: a parent update refreshes every review batch stacked on its branch', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    const first = await reviewedBatchOnBase(x, 2, 'first.txt', parent.branch, 'feature/first', 'first\n');
    const second = await reviewedBatchOnBase(x, 3, 'second.txt', parent.branch, 'feature/second', 'second\n');
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 4, 'parent-update.txt', 'updated parent\n');
    await until(() => x.notes.some((note) => note.startsWith(`Batch ${first.id} refreshed from ${parent.branch}`)) && x.notes.some((note) => note.startsWith(`Batch ${second.id} refreshed from ${parent.branch}`)), WAIT, 'both stacked batches refreshed');

    expect([first, second].map((child) => fs.existsSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', child.id), 'parent-update.txt')))).toEqual([true, true]);
  });

  it('batches: the GitLab watcher records an equal-head merge and refreshes its stacked child', async () => {
    const calls: string[][] = [];
    const targets = new Map([['502', 'feature/parent']]);
    const x = await gitlabStackRepo(mockMrProvider(targets, calls));
    x.db.repos.update('r1', { base_branch: 'dev' });
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt', 'https://gitlab.example.com/group/proj/-/merge_requests/501');
    const childUrl = 'https://gitlab.example.com/group/proj/-/merge_requests/502';
    const child = await reviewedBranchAt(x, 'Child', 'feature/child', parent.branch, 'child.txt', childUrl);
    const parentWt = batchWorktreePath(x.worktreesDir, 'r1', parent.id);
    await shAsync(parentWt, ['push', '-q', 'origin', `${parent.branch}:dev`]);
    const parentHead = await shAsync(parentWt, ['rev-parse', 'HEAD']);
    const childHead = await shAsync(batchWorktreePath(x.worktreesDir, 'r1', child.id), ['rev-parse', 'HEAD']);
    await shAsync(x.repo.path, ['fetch', '-q', 'origin']);
    await shAsync(x.repo.path, ['branch', '-f', 'dev', 'origin/dev']);
    await shAsync(x.repo.path, ['switch', '-q', 'dev']);
    await commitFileAsync(x.repo.path, 'dev-after-merge.txt', 'from dev\n', 'advance dev after parent merge');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'dev']);
    const watcherNotices: { text: string; wake: boolean | undefined }[] = [];
    const merge = vi.spyOn(x.lc, 'mergeBatch');
    const watcher = new GitlabMrWatcher({
      db: x.db,
      fetchMr: async (_repoPath, endpoint) => JSON.stringify(endpoint.endsWith('/501')
        ? { state: 'merged', sha: parentHead }
        : { state: 'opened', sha: childHead }),
      mergeBatch: (id, actor) => x.lc.mergeBatch(id, actor),
      notify: async (text, opts) => { watcherNotices.push({ text, wake: opts?.wake }); },
    });

    await watcher.tick();

    const childWt = batchWorktreePath(x.worktreesDir, 'r1', child.id);
    const retargetNotice = x.notes.find((note) => note.startsWith(`Batch ${child.id} now uses base`))!;
    expect({
      parentStatus: x.db.batches.get(parent.id)?.status,
      mergeCalls: merge.mock.calls,
      watcherNotices,
      base: x.db.batches.get(child.id)?.base_branch,
      update: calls.find((args) => args[1] === 'update'),
      refreshed: fs.existsSync(path.join(childWt, 'dev-after-merge.txt')),
      quietNotice: isQuietNotice(retargetNotice),
      wakes: x.wakes,
    }).toEqual({
      parentStatus: 'merged',
      mergeCalls: [[parent.id, 'gitlab']],
      watcherNotices: [{ text: `Batch ${parent.id} merged on GitLab (!501); recorded.`, wake: false }],
      base: 'dev',
      update: ['mr', 'update', '502', '--target-branch', 'dev', '--yes'],
      refreshed: true,
      quietNotice: true,
      wakes: [],
    });
  });

  it('batches: GitLab merge omits the quiet retarget-success notice when the MR update fails', async () => {
    const calls: string[][] = [];
    const x = await gitlabStackRepo(mockMrProvider(new Map([['505', 'feature/parent']]), calls, 'permission denied'));
    x.db.repos.update('r1', { base_branch: 'dev' });
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt', 'https://gitlab.example.com/group/proj/-/merge_requests/504');
    const child = await reviewedBranchAt(x, 'Child', 'feature/child', parent.branch, 'child.txt', 'https://gitlab.example.com/group/proj/-/merge_requests/505');
    await shAsync(batchWorktreePath(x.worktreesDir, 'r1', parent.id), ['push', '-q', 'origin', `${parent.branch}:dev`]);

    await x.lc.mergeBatch(parent.id, 'gitlab');

    expect({
      childBase: x.db.batches.get(child.id)?.base_branch,
      retargetSuccessLines: x.notes.filter((note) => note.startsWith(`Batch ${child.id} now uses base`)),
      wakes: x.wakes,
    }).toEqual({
      childBase: 'dev',
      retargetSuccessLines: [],
      wakes: [`Batch ${child.id} now uses dev, but MR https://gitlab.example.com/group/proj/-/merge_requests/505 could not be retargeted: glab mr update !505 failed (exit 1): permission denied`],
    });
  });

  it('batches: marking a parent merged updates an open child without an MR or refresh', async () => {
    const calls: string[][] = [];
    const x = await gitlabStackRepo(mockMrProvider(new Map(), calls));
    x.db.repos.update('r1', { base_branch: 'dev' });
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt');
    const child = await reviewedBranchAt(x, 'Open child', 'feature/open-child', parent.branch, 'child.txt', null, 'open');
    await commitFileAsync(batchWorktreePath(x.worktreesDir, 'r1', parent.id), 'parent-after-child.txt', 'later\n', 'advance parent');
    await x.lc.mergeBatch(parent.id);

    const childWt = batchWorktreePath(x.worktreesDir, 'r1', child.id);
    expect({
      base: x.db.batches.get(child.id)?.base_branch,
      status: x.db.batches.get(child.id)?.status,
      refreshFrom: x.db.batches.get(child.id)?.refresh_from,
      containsParentUpdate: fs.existsSync(path.join(childWt, 'parent-after-child.txt')),
      glabCalls: calls,
      quietNotice: isQuietNotice(x.notes.find((note) => note.startsWith(`Batch ${child.id} now uses base`))!),
    }).toEqual({ base: 'dev', status: 'open', refreshFrom: null, containsParentUpdate: false, glabCalls: [], quietNotice: true });
  });

  it('batches: merging a parent retargets both direct children and leaves the next stack base unchanged', async () => {
    const x = await gitlabStackRepo();
    x.db.repos.update('r1', { base_branch: 'dev' });
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt');
    const first = await reviewedBranchAt(x, 'First child', 'feature/first', parent.branch, 'first.txt');
    const second = await reviewedBranchAt(x, 'Second child', 'feature/second', parent.branch, 'second.txt');
    const grandchild = await reviewedBranchAt(x, 'Grandchild', 'feature/grandchild', first.branch, 'grandchild.txt');
    await shAsync(batchWorktreePath(x.worktreesDir, 'r1', parent.id), ['push', '-q', 'origin', `${parent.branch}:dev`]);

    await x.lc.mergeBatch(parent.id);

    expect([first, second, grandchild].map((batch) => x.db.batches.get(batch.id)?.base_branch)).toEqual(['dev', 'dev', first.branch]);
  });

  it('batches: an MR retarget failure keeps the new base and sends one wake notice', async () => {
    const calls: string[][] = [];
    const x = await gitlabStackRepo(mockMrProvider(new Map([['503', 'feature/parent']]), calls, 'permission denied'));
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt');
    const child = await reviewedBranchAt(x, 'Child', 'feature/child', parent.branch, 'child.txt', 'https://gitlab.example.com/group/proj/-/merge_requests/503');
    await x.lc.retargetBatch(child.id, 'dev');

    expect({ base: x.db.batches.get(child.id)?.base_branch, wakes: x.wakes }).toEqual({
      base: 'dev',
      wakes: [`Batch ${child.id} now uses dev, but MR https://gitlab.example.com/group/proj/-/merge_requests/503 could not be retargeted: glab mr update !503 failed (exit 1): permission denied`],
    });
  });

  it('batches: an MR already targeting the new base is a no-op', async () => {
    const calls: string[][] = [];
    const url = 'https://gitlab.example.com/group/proj/-/merge_requests/504';
    const x = await gitlabStackRepo(mockMrProvider(new Map([['504', 'dev']]), calls));
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt');
    const child = await reviewedBranchAt(x, 'Child', 'feature/child', parent.branch, 'child.txt', url);
    const result = await x.lc.retargetBatch(child.id, 'dev');

    expect({ base: x.db.batches.get(child.id)?.base_branch, result, glabCalls: calls, wakes: x.wakes }).toEqual({
      base: 'dev',
      result: { mrUpdated: false },
      glabCalls: [['mr', 'view', '504', '--output', 'json']],
      wakes: [],
    });
  });

  it('batches: abandoning a parent leaves stacked batches in place and wakes once with the choice', async () => {
    const retarget = vi.fn(async () => true);
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }), retargetBatch: retarget };
    const x = await gitlabStackRepo(provider);
    const parent = await x.lc.createBatch('r1', 'Parent', 'feature/parent', null, 'dev');
    const open = await reviewedBranchAt(x, 'Open child', 'feature/open-child', parent.branch, 'open-child.txt', null, 'open');
    const review = await reviewedBranchAt(x, 'Review child', 'feature/review-child', parent.branch, 'review-child.txt');
    await x.lc.abandonBatch(parent.id);

    expect({
      openBase: x.db.batches.get(open.id)?.base_branch,
      reviewBase: x.db.batches.get(review.id)?.base_branch,
      wakes: x.wakes,
      hint: x.hints[0],
      retargetCalls: retarget.mock.calls.length,
    }).toEqual({
      openBase: parent.branch,
      reviewBase: parent.branch,
      wakes: [`Batch ${parent.id} was abandoned; these stacked batches remain on ${parent.branch} and have parent base dev:\n- ${open.id} (${open.branch})\n- ${review.id} (${review.branch})`],
      hint: 'Ask the user whether to move each to dev with retarget_batch or abandon it.',
      retargetCalls: 0,
    });
  });

  it('batches: a merge with no stacked batches does not call retarget or add a retarget notice', async () => {
    const retarget = vi.fn(async () => true);
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }), retargetBatch: retarget };
    const x = await gitlabStackRepo(provider);
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt');
    await x.lc.mergeBatch(parent.id);

    expect({ calls: retarget.mock.calls.length, notices: x.notes.filter((note) => note.includes('now uses base')) }).toEqual({ calls: 0, notices: [] });
  });

  it('batches: a recovery refresh updates a stacked child once from the final parent head', async () => {
    const x = await gitlabStackRepo();
    x.db.repos.update('r1', { base_branch: 'dev' });
    const parent = await reviewedBranchAt(x, 'Parent', 'feature/parent', 'dev', 'parent.txt');
    const child = await reviewedBranchAt(x, 'Child', 'feature/child', parent.branch, 'child.txt');
    x.db.batches.update(parent.id, { status: 'open' });
    const parentWt = batchWorktreePath(x.worktreesDir, 'r1', parent.id);
    await shAsync(parentWt, ['push', '-q', 'origin', `${parent.branch}:dev`]);
    await shAsync(x.repo.path, ['fetch', '-q', 'origin']);
    await shAsync(x.repo.path, ['branch', '-f', 'dev', 'origin/dev']);
    await shAsync(x.repo.path, ['switch', '-q', 'dev']);
    await commitFileAsync(x.repo.path, 'deferred-base.txt', 'from dev\n', 'advance deferred base');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'dev']);
    const refreshHead = await shAsync(x.repo.path, ['rev-parse', 'origin/dev']);
    x.db.batches.update(parent.id, { refresh_from: child.id, refresh_head: refreshHead, conflict_files: ['deferred-base.txt'] });

    await landBatchBead(x, parent.id, 2, 'recovery-bead.txt', 'recovery\n');
    await until(() => x.notes.some((note) => note.startsWith(`Batch ${child.id} refreshed from ${parent.branch} after ${parent.id}`)), WAIT, 'stacked child recovery refresh');

    expect({
      childRefreshes: x.notes.filter((note) => note.startsWith(`Batch ${child.id} refreshed from ${parent.branch} after ${parent.id}`)).length,
      parentBaseIncluded: fs.existsSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', child.id), 'deferred-base.txt')),
      recoveryBeadIncluded: fs.existsSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', child.id), 'recovery-bead.txt')),
    }).toEqual({ childRefreshes: 1, parentBaseIncluded: true, recoveryBeadIncluded: true });
  });

  it('batches: a stacked review refresh triggers the next level in the chain', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    const child = await reviewedBatchOnBase(x, 2, 'child.txt', parent.branch, 'feature/child', 'child\n');
    const grandchild = await reviewedBatchOnBase(x, 3, 'grandchild.txt', child.branch, 'feature/grandchild', 'grandchild\n');
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 4, 'parent-update.txt', 'updated parent\n');
    await until(() => x.notes.some((note) => note.startsWith(`Batch ${grandchild.id} refreshed from ${child.branch}`)), WAIT, 'grandchild refresh');

    expect(fs.existsSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', grandchild.id), 'parent-update.txt'))).toBe(true);
  });

  it('batches: a bead landing on a batch with no stacked review batch triggers no refresh', async () => {
    const x = await gitlabStackRepo();
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    await x.lc.rejectBatch(parent.id, 'Rework the parent');
    await landBatchBead(x, parent.id, 2, 'parent-update.txt', 'updated parent\n');

    expect(x.notes.some((note) => note.includes('refreshed from'))).toBe(false);
  });

  it('batches: a dev merge refreshes its sibling and its stacked review child', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    await shAsync(x.repo.path, ['branch', 'dev', 'main']);
    const origin = await addBareOrigin(x.repo.path);
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'dev']);
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    await shAsync(x.repo.path, ['push', '-q', 'origin', parent.branch]);
    const merged = await reviewedBatchOnBase(x, 2, 'dev-merge.txt', 'dev', 'feature/dev-merge', 'merged\n');
    const stacked = await reviewedBatchOnBase(x, 3, 'stacked.txt', parent.branch, 'feature/stacked', 'stacked\n');

    await shAsync(x.repo.path, ['push', '-q', 'origin', merged.branch]);
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-upstream-'));
    await shAsync(upstream, ['clone', '-q', '-b', 'dev', origin, '.']);
    await shAsync(upstream, ['fetch', '-q', 'origin', merged.branch]);
    await shAsync(upstream, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'merge', '-q', '--no-ff', '-m', 'merge dev batch', `origin/${merged.branch}`]);
    await shAsync(upstream, ['push', '-q', 'origin', 'dev']);
    await x.lc.mergeBatch(merged.id);

    const parentWt = batchWorktreePath(x.worktreesDir, 'r1', parent.id);
    const stackedWt = batchWorktreePath(x.worktreesDir, 'r1', stacked.id);
    expect({
      parentContainsDevMerge: fs.existsSync(path.join(parentWt, 'dev-merge.txt')),
      stackedContainsDevMerge: fs.existsSync(path.join(stackedWt, 'dev-merge.txt')),
      stackedRefreshFrom: x.db.batches.get(stacked.id)?.refresh_from,
      parentNotice: x.notes.find((note) => note.startsWith(`Batch ${parent.id} refreshed from`)),
      stackedNotice: x.notes.find((note) => note.startsWith(`Batch ${stacked.id} refreshed from`)),
    }).toEqual({
      parentContainsDevMerge: true,
      stackedContainsDevMerge: true,
      stackedRefreshFrom: null,
      parentNotice: `Batch ${parent.id} refreshed from dev after ${merged.id}; verify command \`node -e "process.exit(0)"\` passed`,
      stackedNotice: `Batch ${stacked.id} refreshed from ${parent.branch} after ${parent.id}; verify command \`node -e "process.exit(0)"\` passed`,
    });
  });

  it('batches: recovery refreshes a stacked batch from its active local parent base', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    await shAsync(x.repo.path, ['branch', 'dev', 'main']);
    await addBareOrigin(x.repo.path);
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'dev']);
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    await shAsync(x.repo.path, ['push', '-q', 'origin', parent.branch]);
    const queued = await reviewedBatchOnBase(x, 2, 'collision.txt', parent.branch, 'feature/queued', 'queued\n');
    const stacked = await reviewedBatchOnBase(x, 3, 'collision.txt', parent.branch, 'feature/stacked', 'stacked\n');
    const parentWt = batchWorktreePath(x.worktreesDir, 'r1', parent.id);
    const queuedWt = batchWorktreePath(x.worktreesDir, 'r1', queued.id);
    const queuedHead = await shAsync(queuedWt, ['rev-parse', 'HEAD']);
    await shAsync(parentWt, ['merge', '-q', '--no-ff', '-m', 'merge queued sibling', queued.branch]);
    await commitFileAsync(parentWt, 'parent-update.txt', 'latest parent\n', 'advance parent after sibling');

    await x.lc.mergeBatch(queued.id);
    const queuedConflict = x.db.batches.get(stacked.id);
    await x.lc.rejectBatch(stacked.id, 'resolve stacked refresh');
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Resolve stacked refresh' });
    const sid = await x.lc.spawnWorker('r1', 'ov-4', { harness: 'claude', batchId: stacked.id });
    const beadWt = x.db.worktrees.get('ov-4')!.path;
    try { await shAsync(beadWt, ['merge', '-q', '--no-ff', '-m', 'merge queued sibling', queuedHead]); } catch { /* resolve the expected conflict below */ }
    await commitFileAsync(beadWt, 'collision.txt', 'queued\n', 'resolve queued sibling');
    x.finishTurn(sid);
    await until(() => x.notes.some((note) => note.startsWith(`Batch ${stacked.id} refreshed from ${parent.branch} after ${queued.id}`)), WAIT, 'stacked recovery refresh');

    const stackedWt = batchWorktreePath(x.worktreesDir, 'r1', stacked.id);
    expect({
      queuedConflict: { status: queuedConflict?.status, conflict_files: queuedConflict?.conflict_files, refresh_from: queuedConflict?.refresh_from, refresh_head: queuedConflict?.refresh_head },
      parentUpdateIncluded: fs.existsSync(path.join(stackedWt, 'parent-update.txt')),
      refreshState: { refresh_from: x.db.batches.get(stacked.id)?.refresh_from, refresh_head: x.db.batches.get(stacked.id)?.refresh_head, conflict_files: x.db.batches.get(stacked.id)?.conflict_files },
      refreshNotice: x.notes.find((note) => note.startsWith(`Batch ${stacked.id} refreshed from`)),
    }).toEqual({
      queuedConflict: { status: 'review', conflict_files: ['collision.txt'], refresh_from: queued.id, refresh_head: queuedHead },
      parentUpdateIncluded: true,
      refreshState: { refresh_from: null, refresh_head: null, conflict_files: null },
      refreshNotice: `Batch ${stacked.id} refreshed from ${parent.branch} after ${queued.id}; verify command \`node -e "process.exit(0)"\` passed`,
    });
  });

  it('batches: a busy stacked batch retains its refresh head and later refreshes from its local parent base', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    await shAsync(x.repo.path, ['branch', 'dev', 'main']);
    await addBareOrigin(x.repo.path);
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'dev']);
    const parent = await reviewedBatchOnBase(x, 1, 'parent.txt', 'dev', 'feature/parent', 'parent\n');
    await shAsync(x.repo.path, ['push', '-q', 'origin', parent.branch]);
    const queued = await reviewedBatchOnBase(x, 2, 'queued.txt', parent.branch, 'feature/queued', 'queued\n');
    const stacked = await reviewedBatchOnBase(x, 3, 'stacked.txt', parent.branch, 'feature/stacked', 'stacked\n');
    const parentWt = batchWorktreePath(x.worktreesDir, 'r1', parent.id);
    const queuedWt = batchWorktreePath(x.worktreesDir, 'r1', queued.id);
    const queuedHead = await shAsync(queuedWt, ['rev-parse', 'HEAD']);
    await shAsync(parentWt, ['merge', '-q', '--no-ff', '-m', 'merge queued sibling', queued.branch]);
    await commitFileAsync(parentWt, 'parent-update.txt', 'latest parent\n', 'advance parent after sibling');
    x.db.sessions.insert({ id: 's-busy-stack', harness: 'claude', role: 'worker', bead_id: 'ov-3', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/wt', batch_id: stacked.id, log_path: null, log_offset: 0, tier: null, model: null, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null });

    await x.lc.mergeBatch(queued.id);
    const deferred = x.db.batches.get(stacked.id);
    x.db.sessions.update('s-busy-stack', { status: 'ended', ended_at: new Date().toISOString() });
    await x.lc.rejectBatch(stacked.id, 'continue after deferred refresh');
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Continue stacked batch' });
    const sid = await x.lc.spawnWorker('r1', 'ov-4', { harness: 'claude', batchId: stacked.id });
    await commitFileAsync(x.db.worktrees.get('ov-4')!.path, 'landed.txt', 'landed\n', 'continue stacked batch');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.startsWith('ov-4 landed on') ?? false, WAIT, 'stacked bead integrated');

    const stackedWt = batchWorktreePath(x.worktreesDir, 'r1', stacked.id);
    expect({
      deferred: { refresh_from: deferred?.refresh_from, refresh_head: deferred?.refresh_head },
      refreshed: { refresh_from: x.db.batches.get(stacked.id)?.refresh_from, refresh_head: x.db.batches.get(stacked.id)?.refresh_head },
      queuedBaseIncluded: fs.existsSync(path.join(stackedWt, 'queued.txt')),
      parentBaseIncluded: fs.existsSync(path.join(stackedWt, 'parent-update.txt')),
      beadLanded: fs.existsSync(path.join(stackedWt, 'landed.txt')),
      refreshNotice: x.notes.find((note) => note.startsWith(`Batch ${stacked.id} refreshed from`)),
    }).toEqual({
      deferred: { refresh_from: queued.id, refresh_head: queuedHead },
      refreshed: { refresh_from: null, refresh_head: null },
      queuedBaseIncluded: true,
      parentBaseIncluded: true,
      beadLanded: true,
      refreshNotice: `Batch ${stacked.id} refreshed from ${parent.branch} after ${queued.id}; verify command \`node -e "process.exit(0)"\` passed`,
    });
  });

  it('batches: a refreshed batch whose verification fails goes back to open with the output and a notice', async () => {
    // Passes in each bead's own worktree (one file each) and fails once the refresh brings both files together.
    const x = setup(`node -e "process.exit(require('fs').existsSync('hello.txt')&&require('fs').existsSync('bye.txt')?1:0)"`);
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await x.lc.mergeBatch('r1-b1');
    const b2 = x.db.batches.get('r1-b2')!;
    expect(b2).toMatchObject({ status: 'open', note: null, waiting_on: null, conflict_files: null });
    expect(b2.history).toContain('Adds bye.txt');
    expect(b2.history).toContain('Verification failed after the refresh from main (after r1-b1):');
    expect(x.wakes.at(-1)).toMatch(/^Batch r1-b2 refreshed from main after r1-b1, and the verify command `node -e .* failed on feature\/batch-2; it is back to open\./);
    expect(x.db.signals.forBatch('r1-b2').map((r) => r.kind)).toContain('rejection');
  });

  it('batches: a refresh conflict is aborted, keeps the branch in review, and wakes for a merge bead', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt', 'from b1\n');
    await reviewedBatch(x, 2, 'hello.txt', 'from b2\n');
    expect(x.db.batches.get('r1-b2')?.waiting_on).toBe('r1-b1');
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', conflict_files: ['hello.txt'], refresh_from: 'r1-b1' });
    expect(x.wakes.at(-1)).toBe('Batch r1-b2 could not be refreshed from main after r1-b1: conflicts in hello.txt. Add a merge bead. The batch is still in review; reject it first if the bead needs to run.');
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(await shAsync(wt, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(wt, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'hello.txt'), 'utf8')).toBe('from b2\n');
    expect(x.db.signals.forBatch('r1-b2')).toMatchObject([{ kind: 'correction', text: 'Refresh from main after r1-b1 conflicted in: hello.txt' }]);
    expect((await x.lc.retrospective('r1-b2')).signals.corrections).toMatchObject([
      { text: 'Refresh from main after r1-b1 conflicted in: hello.txt', matched: 'lifecycle' },
    ]);
    expect(x.notes.some((n) => n.includes('no longer waits'))).toBe(false);
  });

  it('batches: a recovery bead that merges the queued base clears refresh conflict metadata', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt', 'from b1\n');
    await reviewedBatch(x, 2, 'hello.txt', 'from b2\n');
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ conflict_files: ['hello.txt'], refresh_from: 'r1-b1', refresh_head: expect.any(String) });

    await x.lc.rejectBatch('r1-b2', 'resolve the refresh conflict');
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Merge main' });
    const sid = await x.lc.spawnWorker('r1', 'ov-3', { harness: 'claude', batchId: 'r1-b2' });
    const beadWt = x.db.worktrees.get('ov-3')!.path;
    try { await shAsync(beadWt, ['merge', '--no-ff', 'main']); } catch { /* resolve the expected conflict below */ }
    await commitFileAsync(beadWt, 'hello.txt', 'from b1\n', 'resolve main conflict');
    const conflictWakeCount = x.wakes.filter((notice) => notice.includes('could not be refreshed')).length;
    x.finishTurn(sid);
    await until(() => x.db.batches.get('r1-b2')?.refresh_from === null, WAIT, 'refresh conflict cleared');

    expect(x.db.batches.get('r1-b2')).toMatchObject({ refresh_from: null, refresh_head: null, conflict_files: null });
    expect(x.wakes.filter((notice) => notice.includes('could not be refreshed'))).toHaveLength(conflictWakeCount);
  });

  it('batches: a recovery refresh failure still lands and closes its bead', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt', 'from b1\n');
    await reviewedBatch(x, 2, 'hello.txt', 'from b2\n');
    await x.lc.mergeBatch('r1-b1');
    await x.lc.rejectBatch('r1-b2', 'resolve the refresh conflict');
    const hooks = path.join(x.repo.path, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\nif grep -q "merge main" "$1"; then echo "refresh hook rejected" >&2; exit 1; fi\nexit 0\n', { mode: 0o755 });
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Resolve refresh conflict' });
    const sid = await x.lc.spawnWorker('r1', 'ov-3', { harness: 'claude', batchId: 'r1-b2' });
    await commitFileAsync(x.db.worktrees.get('ov-3')!.path, 'hello.txt', 'from b1\n', 'resolve conflict');
    x.finishTurn(sid);
    await until(() => x.wakes.some((notice) => notice.startsWith('Batch r1-b2 landed ov-3 but the refresh from main failed:')), WAIT, 'recovery refresh failure');

    expect(await x.status('ov-3')).toBe('closed');
    expect(await x.phase('ov-3')).toBe('merged');
    expect(x.db.worktrees.get('ov-3')?.merged_at).toBeTruthy();
    expect(x.wakes.at(-1)).toMatch(/^Batch r1-b2 landed ov-3 but the refresh from main failed: [\s\S]*refresh hook rejected[\s\S]*Add a merge bead\.$/);
  });

  it('batches: conflict_files clears once a later refresh of the same batch succeeds', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt', 'from b1\n');
    await reviewedBatch(x, 2, 'hello.txt', 'from b2\n');
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')?.conflict_files).toEqual(['hello.txt']);
    // A merge bead resolves the conflict by hand on the batch branch, matching what main already has, so the next refresh
    // (triggered here by another batch merging) is a clean no-op merge instead of a conflict.
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    await commitFileAsync(wt, 'hello.txt', 'from b1\n', 'resolve conflict with main');
    await reviewedBatch(x, 3, 'more.txt');
    await x.lc.mergeBatch('r1-b3');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', conflict_files: null, refresh_from: null });
  });

  it('batches: a batch with a running worker is not refreshed at merge time; the merge runs before its next bead lands', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    x.db.sessions.insert({ id: 's-busy', harness: 'claude', role: 'worker', bead_id: 'ov-2', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/wt', batch_id: 'r1-b2', log_path: null, log_offset: 0, tier: null, model: null, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null });
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', refresh_from: 'r1-b1' });
    expect(x.notes.some((n) => n.includes('refreshed from'))).toBe(false);
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(false);
    x.db.sessions.update('s-busy', { status: 'ended', ended_at: new Date().toISOString() });
    await x.lc.rejectBatch('r1-b2', 'one more file');
    expect(x.db.batches.get('r1-b2')?.refresh_from).toBe('r1-b1');
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Bead 4', description: 'Write more.txt' });
    const sid = await x.lc.spawnWorker('r1', 'ov-4', { harness: 'claude', batchId: 'r1-b2' });
    await commitFileAsync(x.db.worktrees.get('ov-4')!.path, 'more.txt', 'more\n', 'add more.txt');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.startsWith('ov-4 landed on') ?? false, WAIT, 'ov-4 integrated');
    expect(x.db.batches.get('r1-b2')?.refresh_from).toBeNull();
    expect(x.notes).toContain('Batch r1-b2 refreshed from main after r1-b1; verify command `node -e "process.exit(0)"` passed');
    for (const f of ['hello.txt', 'bye.txt', 'more.txt']) expect(fs.existsSync(path.join(wt, f))).toBe(true);
  });

  it('batches: gitlab-mr pushes the refreshed branch so the MR updates', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true, mrUrl: 'https://gitlab.example.com/g/p/-/merge_requests/1' }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'feature/batch-1']);
    // Simulate GitLab moving the remote base while this checkout's local main and origin/main remain stale.
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-upstream-'));
    await shAsync(upstream, ['clone', '-q', '-b', 'main', bare, '.']);
    const mergedHead = await shAsync(bare, ['rev-parse', 'refs/heads/feature/batch-1']);
    await shAsync(upstream, ['fetch', '-q', 'origin', 'feature/batch-1']);
    await shAsync(upstream, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'merge', '-q', '--no-ff', '-m', 'merge b1', mergedHead]);
    await shAsync(upstream, ['push', '-q', 'origin', 'main']);
    expect(fs.existsSync(path.join(x.repo.path, 'hello.txt'))).toBe(false);
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')?.status).toBe('review');
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(true);
    expect(await shAsync(bare, ['rev-parse', 'refs/heads/feature/batch-2'])).toBe(await shAsync(wt, ['rev-parse', 'HEAD']));
    expect(await shAsync(wt, ['log', '-1', '--format=%B'])).toContain('Source: origin/main');
  });

  it('batches: gitlab-mr defers instead of falling back to the local base when origin is unavailable', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');

    await x.lc.mergeBatch('r1-b1');

    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', refresh_from: 'r1-b1' });
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(false);
    expect(x.wakes.at(-1)).toContain('Warning: origin/main is unavailable');
  });

  it('batches: gitlab-mr accepts the fetched base after a GitLab squash merge removes its source branch', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'feature/batch-1']);
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-upstream-'));
    await shAsync(upstream, ['clone', '-q', '-b', 'main', bare, '.']);
    const mergedHead = await shAsync(bare, ['rev-parse', 'refs/heads/feature/batch-1']);
    await shAsync(upstream, ['fetch', '-q', 'origin', 'feature/batch-1']);
    await shAsync(upstream, ['merge', '-q', '--squash', mergedHead]);
    await shAsync(upstream, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'squash b1']);
    await shAsync(upstream, ['push', '-q', 'origin', 'main']);
    await shAsync(upstream, ['push', '-q', 'origin', '--delete', 'feature/batch-1']);
    await x.lc.mergeBatch('r1-b1');
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', refresh_from: null, refresh_head: null, conflict_files: null });
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(true);
    expect(x.wakes.some((w) => w.includes('does not contain the merged batch head yet'))).toBe(false);
  });

  it('batches: gitlab-mr defers refresh when the local origin ref is stale and the remote has advanced with unrelated commits, instead of merging past the missing sibling', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'feature/batch-1']);
    // The batch worktrees' local refs/remotes/origin/main is stale (never fetched since the initial push). The bare remote
    // then advances with a commit that has nothing to do with r1-b1's merge, simulating an un-refetched origin plus a race.
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-upstream-'));
    await shAsync(upstream, ['clone', '-q', '-b', 'main', bare, '.']);
    await shAsync(upstream, ['config', 'core.autocrlf', 'false']);
    await commitFileAsync(upstream, 'unrelated.txt', 'unrelated\n', 'unrelated upstream change');
    await shAsync(upstream, ['push', '-q', 'origin', 'main']);
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', refresh_from: 'r1-b1' });
    expect(x.wakes.at(-1)).toContain('the fetched origin/main does not contain the merged batch head yet');
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'unrelated.txt'))).toBe(false);
  });

  it('batches: a later sibling merge cannot bypass an earlier deferred ancestry guard', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    await reviewedBatch(x, 1, 'one.txt');
    await reviewedBatch(x, 2, 'two.txt');
    await reviewedBatch(x, 3, 'three.txt');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'feature/batch-1', 'feature/batch-2']);
    const b2Head = await shAsync(batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2'), ['rev-parse', 'HEAD']);
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b3')).toMatchObject({ refresh_from: 'r1-b1', refresh_head: expect.any(String) });
    await x.lc.mergeBatch('r1-b2');

    expect(x.db.batches.get('r1-b3')).toMatchObject({ refresh_from: 'r1-b2', refresh_head: b2Head });
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b3');
    expect(fs.existsSync(path.join(wt, 'one.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'two.txt'))).toBe(false);
  });

  it('batches: gitlab-mr defers refresh when origin has not received the merged batch head', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'feature/batch-1']);
    await x.lc.mergeBatch('r1-b1'); // GitLab has not merged feature/batch-1 into origin/main yet.
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', refresh_from: 'r1-b1' });
    expect(x.wakes.at(-1)).toContain('the fetched origin/main does not contain the merged batch head yet');
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(false);
  });

  it('batches: gitlab-mr checks the base again when a deferred refresh runs, instead of merging a base that still lacks the sibling', async () => {
    const provider: GitProvider = { land: async () => ({ ok: true }), landBatch: async () => ({ ok: true }) };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bare-'));
    await shAsync(bare, ['init', '--bare', '-q']);
    await shAsync(x.repo.path, ['remote', 'add', 'origin', bare]);
    await shAsync(x.repo.path, ['push', '-q', '-u', 'origin', 'main']);
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    await shAsync(x.repo.path, ['push', '-q', 'origin', 'feature/batch-1']);
    const b1Head = await shAsync(batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1'), ['rev-parse', 'HEAD']);
    x.db.sessions.insert({ id: 's-busy', harness: 'claude', role: 'worker', bead_id: 'ov-2', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/wt', batch_id: 'r1-b2', log_path: null, log_offset: 0, tier: null, model: null, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null });
    await x.lc.mergeBatch('r1-b1');
    // The busy batch records both what to merge and the head the fetched base must contain, so the deferred run can check it too.
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', refresh_from: 'r1-b1', refresh_head: b1Head });

    x.db.sessions.update('s-busy', { status: 'ended', ended_at: new Date().toISOString() });
    await x.lc.rejectBatch('r1-b2', 'one more file');
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Bead 4', description: 'Write more.txt' });
    const sid = await x.lc.spawnWorker('r1', 'ov-4', { harness: 'claude', batchId: 'r1-b2' });
    await commitFileAsync(x.db.worktrees.get('ov-4')!.path, 'more.txt', 'more\n', 'add more.txt');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.startsWith('ov-4 landed on') ?? false, WAIT, 'ov-4 integrated');
    // origin/main still lacks r1-b1's head, so the refresh is deferred again and the bead lands on the unrefreshed branch.
    expect(x.db.batches.get('r1-b2')).toMatchObject({ refresh_from: 'r1-b1', refresh_head: b1Head });
    expect(x.wakes.some((w) => w.includes('Batch r1-b2 was not refreshed from main after r1-b1: the fetched origin/main does not contain the merged batch head yet'))).toBe(true);
    const wt = batchWorktreePath(x.worktreesDir, 'r1', 'r1-b2');
    expect(fs.existsSync(path.join(wt, 'hello.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'more.txt'))).toBe(true);
  });

  it('batches: a batch whose files do not overlap the one in review is not held', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'bye.txt');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: null, overlap_files: null });
    expect(x.notes.some((n) => n.includes('waiting on'))).toBe(false);
    await x.lc.mergeBatch('r1-b2');
    expect(x.db.batches.get('r1-b2')?.status).toBe('merged');
  });

  it('batches: a three-way chain re-points the last batch at the next one in review when the first merges', async () => {
    const x = setup();
    // One shared file, each batch changing its own line: the refreshes merge cleanly and every batch still changes the file afterwards.
    const lines = (n: number, v: string) => Array.from({ length: 20 }, (_, i) => (i === n ? v : `line ${i}`)).join('\n') + '\n';
    await commitFileAsync(x.repo.path, 'shared.txt', lines(-1, ''), 'add shared.txt');
    await reviewedBatch(x, 1, 'shared.txt', lines(0, 'one'));
    await reviewedBatch(x, 2, 'shared.txt', lines(10, 'two'));
    await reviewedBatch(x, 3, 'shared.txt', lines(19, 'three'));
    expect(x.db.batches.get('r1-b2')?.waiting_on).toBe('r1-b1');
    expect(x.db.batches.get('r1-b3')?.waiting_on).toBe('r1-b1');
    await x.lc.mergeBatch('r1-b1');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ waiting_on: null, overlap_files: null });
    expect(x.db.batches.get('r1-b3')).toMatchObject({ waiting_on: 'r1-b2', overlap_files: ['shared.txt'] });
    expect(x.notes.filter((n) => n.includes('no longer waits'))).toEqual(['Batch r1-b2 no longer waits: r1-b1 left review, so its Merge is available.']);
  });

  it('batches: recover releases a batch still waiting on one that left review (2026-09-14: a hook rejection after Mark merged skipped the release)', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'hello.txt');
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: 'r1-b1' });
    // The release never ran: the row says merged while the waiter still points at it.
    x.db.batches.update('r1-b1', { status: 'merged', merged_at: new Date().toISOString() });
    await x.lc.recover();
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: null, overlap_files: null });
    await x.lc.mergeBatch('r1-b2');
    expect(x.db.batches.get('r1-b2')?.status).toBe('merged');
  });

  it('batches: rejecting the batch another one waits on releases the waiter', async () => {
    const x = setup();
    await reviewedBatch(x, 1, 'hello.txt');
    await reviewedBatch(x, 2, 'hello.txt');
    await x.lc.rejectBatch('r1-b1', 'not yet');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'open', waiting_on: null });
    expect(x.db.batches.get('r1-b2')).toMatchObject({ status: 'review', waiting_on: null, overlap_files: null });
    await x.lc.mergeBatch('r1-b2');
    expect(x.db.batches.get('r1-b2')?.status).toBe('merged');
  });

  it('batches: a successful review request emits one review_ready milestone', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));

    await x.lc.requestBatchReview('r1', batch.id, 'note');

    expect(milestones).toEqual([expectedBatchMilestone('review_ready', batch.id)]);
  });

  it('batches: requesting review again after rejection emits exactly one additional review_ready milestone', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));

    await x.lc.requestBatchReview('r1', batch.id, 'first note');
    const beforeReRequest = milestones.length;
    await x.lc.rejectBatch(batch.id, 'please revise');
    await x.lc.requestBatchReview('r1', batch.id, 'second note');

    expect(milestones.slice(beforeReRequest)).toEqual([expectedBatchMilestone('review_ready', batch.id)]);
  });

  it('batches: a refused review request emits no milestone', async () => {
    const x = setup();
    const batch = await x.lc.createBatch('r1', 'Not ready');
    x.store.add(x.repo.path, { id: 'ov-unfinished', title: 'Unfinished', labels: [`overseer:batch:${batch.id}`] });
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));
    let refusal: string | null = null;
    try { await x.lc.requestBatchReview('r1', batch.id, 'note'); }
    catch (error) { refusal = (error as Error).message; }

    expect({ refusal, milestones }).toEqual({ refusal: `batch ${batch.id} still open: ov-unfinished not done`, milestones: [] });
  });

  it('batches: a re-request while in review is refused without a milestone', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    await x.lc.requestBatchReview('r1', batch.id, 'first note');
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));
    let refusal: string | null = null;
    try { await x.lc.requestBatchReview('r1', batch.id, 'updated note'); }
    catch (error) { refusal = (error as Error).message; }

    expect({ refusal, milestones }).toEqual({ refusal: `batch ${batch.id} is review`, milestones: [] });
  });

  it('batches: a waiting review request emits one review_ready milestone', async () => {
    const x = setup();
    const first = await reviewedBatch(x, 1, 'shared.txt');
    const second = await landedBatch(x, 2, 'shared.txt');
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));

    await x.lc.requestBatchReview('r1', second, 'note');

    expect({ waitingOn: x.db.batches.get(second)?.waiting_on, milestones }).toEqual({
      waitingOn: first,
      milestones: [expectedBatchMilestone('review_ready', second)],
    });
  });

  it('batches: a successful local merge emits one merged milestone', async () => {
    const x = setup();
    const batchId = await reviewedBatch(x, 1, 'merged.txt');
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));

    await x.lc.mergeBatch(batchId);

    expect(milestones).toEqual([expectedBatchMilestone('merged', batchId)]);
  });

  it('batches: a failed merge emits no merged milestone', async () => {
    const gated = gatedMerge(true);
    const x = setup(undefined, 3, { provider: gated.provider });
    await batchInReview(x);
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));
    const merge = x.lc.mergeBatch('r1-b1').then(() => null, (error: Error) => error.message);
    await gated.entered;
    gated.open();
    const failure = await merge;

    expect({ failure, milestones }).toEqual({ failure: 'merge conflict in README.md', milestones: [] });
  });

  it('batches: landing a bead on its batch branch emits no merged milestone', async () => {
    const x = setup();
    const batch = await x.lc.createBatch('r1', 'Landing');
    const mergedMilestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => { if (milestone.kind === 'merged') mergedMilestones.push(milestone); });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: batch.id });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'landed.txt', 'landed\n', 'land bead');
    x.finishTurn(sid);
    await until(() => x.notes.some((note) => note.startsWith('ov-1 landed on')), WAIT, 'bead landed on batch branch');

    expect(mergedMilestones).toEqual([]);
  });

  it('batches: rejecting and abandoning a batch emit no office milestone', async () => {
    const x = setup();
    await batchInReview(x);
    const milestones: unknown[] = [];
    x.bus.on('office_milestone', (milestone) => milestones.push(milestone));

    await x.lc.rejectBatch('r1-b1', 'retry');
    await x.lc.abandonBatch('r1-b1');

    expect(milestones).toEqual([]);
  });

  it('batches: a null review command keeps the existing review flow', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    await x.lc.requestBatchReview('r1', batch.id, 'note');
    expect(x.db.batches.get(batch.id)).toMatchObject({ status: 'review', review_check: null });
  });

  it('batches: a passing review command runs after setup and stores its result and counts', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    const command = `node -e "if (!require('fs').existsSync('setup-marker.txt')) process.exit(9); require('fs').appendFileSync('review-runs.txt','x'); console.log('Tests 5 passed | 2 skipped | 1 todo (8)')"`;
    x.db.repos.update('r1', { setup_command: `node -e "require('fs').writeFileSync('setup-marker.txt','ready')"`, review_command: command });
    await x.lc.requestBatchReview('r1', batch.id, 'note');
    const headSha = await shAsync(worktree, ['rev-parse', 'HEAD']);
    expect(x.db.batches.get(batch.id)).toMatchObject({
      status: 'review',
      setup_at: expect.any(String),
      review_check: { status: 'pass', command, head_sha: headSha, exit_code: 0, output_tail: expect.stringContaining('Tests 5 passed'), counts: { passed: 5, failed: 0, skipped: 2, todo: 1, flaky: 0 } },
    });
  });

  it('batches: concurrent requestBatchReview calls run the review command once', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    x.db.repos.update('r1', { review_command: `node -e "require('fs').appendFileSync('review-runs.txt','x'); console.log('4 passed (1s)')"` });
    const results = await Promise.allSettled([
      x.lc.requestBatchReview('r1', batch.id, 'first'),
      x.lc.requestBatchReview('r1', batch.id, 'second'),
    ]);
    expect({ results: results.map((r) => r.status).sort(), runs: fs.readFileSync(path.join(worktree, 'review-runs.txt'), 'utf8'), status: x.db.batches.get(batch.id)?.status })
      .toEqual({ results: ['fulfilled', 'rejected'], runs: 'x', status: 'review' });
  });

  it('batches: unknown review output stores no counts', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    x.db.repos.update('r1', { review_command: `node -e "console.log('suite complete')"` });
    await x.lc.requestBatchReview('r1', batch.id, 'note');
    expect(x.db.batches.get(batch.id)?.review_check?.counts).toBeNull();
  });

  it('batches: a failed review command keeps the batch open and sends one wake notice', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    x.wakes.length = 0;
    const command = `node -e "require('fs').appendFileSync('review-runs.txt','x'); console.log('failure-tail'); process.exit(7)"`;
    x.db.repos.update('r1', { review_command: command });
    const errors: string[] = [];
    try { await x.lc.requestBatchReview('r1', batch.id, 'note'); }
    catch (error) { errors.push((error as Error).message); }
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    const wake = x.wakes[0] ?? '';
    expect({ batch: x.db.batches.get(batch.id), runs: fs.readFileSync(path.join(worktree, 'review-runs.txt'), 'utf8'), errors, wakeCount: x.wakes.length, wakeHasCommandAndExit: wake.includes(`Review command \`${command}\` failed with exit code 7`), wakeHasTail: wake.includes('failure-tail') })
      .toMatchObject({ batch: { status: 'open', review_check: { status: 'fail', exit_code: 7 } }, runs: 'x', errors: [expect.stringContaining('exit code 7')], wakeCount: 1, wakeHasCommandAndExit: true, wakeHasTail: true });
  });

  it('batches: a failed review command changed at the same head runs again and requests review', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    x.db.repos.update('r1', { review_command: `node -e "process.exit(1)"` });
    await x.lc.requestBatchReview('r1', batch.id, 'note').catch(() => undefined);
    const fixed = `node -e "console.log('1 passed (1s)')"`;
    x.db.repos.update('r1', { review_command: fixed });
    await x.lc.requestBatchReview('r1', batch.id, 'note');
    expect(x.db.batches.get(batch.id)).toMatchObject({ status: 'review', review_check: { status: 'pass', command: fixed } });
  });

  it('batches: a failed review command with the same command at the same head runs again', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    x.db.repos.update('r1', { review_command: `node -e "require('fs').appendFileSync('review-runs.txt','x'); process.exit(1)"` });
    for (let attempt = 0; attempt < 2; attempt++) await x.lc.requestBatchReview('r1', batch.id, 'note').catch(() => undefined);
    expect(fs.readFileSync(path.join(worktree, 'review-runs.txt'), 'utf8')).toBe('xx');
  });

  it('batches: a timed-out review command at the same head runs again', async () => {
    const x = setup(undefined, 3, { reviewCommandTimeoutMs: 1500 });
    const batch = await batchReadyForReview(x);
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    x.db.repos.update('r1', { review_command: `node -e "require('fs').appendFileSync('review-runs.txt','x'); setTimeout(()=>process.exit(0),5000)"` });
    for (let attempt = 0; attempt < 2; attempt++) await x.lc.requestBatchReview('r1', batch.id, 'note').catch(() => undefined);
    expect(fs.readFileSync(path.join(worktree, 'review-runs.txt'), 'utf8')).toBe('xx');
  });

  it('batches: a passing check at the same head is rerun when the command changed', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    x.db.repos.update('r1', { review_command: `node -e "console.log('1 passed (1s)')"` });
    await x.lc.requestBatchReview('r1', batch.id, 'first');
    await x.lc.rejectBatch(batch.id, 'retry');
    const changed = `node -e "console.log('2 passed (1s)')"`;
    x.db.repos.update('r1', { review_command: changed });
    await x.lc.requestBatchReview('r1', batch.id, 'second');
    expect(x.db.batches.get(batch.id)?.review_check).toMatchObject({ command: changed, counts: { passed: 2 } });
  });

  it('batches: a review command timeout is recorded as a failure', async () => {
    const x = setup(undefined, 3, { reviewCommandTimeoutMs: 120 });
    const batch = await batchReadyForReview(x);
    x.db.repos.update('r1', { review_command: `node -e "setTimeout(()=>process.exit(0),5000)"` });
    let error = '';
    try { await x.lc.requestBatchReview('r1', batch.id, 'note'); }
    catch (e) { error = (e as Error).message; }
    const check = x.db.batches.get(batch.id)?.review_check;
    expect({ error, status: x.db.batches.get(batch.id)?.status, check })
      .toMatchObject({ error: expect.stringContaining('(timed out)'), status: 'open', check: { status: 'fail', exit_code: null, output_tail: expect.stringContaining('(timed out)') } });
  });

  it('batches: an already recorded passing check is reused for the same head', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    x.db.repos.update('r1', { review_command: `node -e "require('fs').appendFileSync('review-runs.txt','x'); console.log('4 passed (18.8s)')"` });
    await x.lc.requestBatchReview('r1', batch.id, 'first');
    await x.lc.rejectBatch(batch.id, 'retry');
    await x.lc.requestBatchReview('r1', batch.id, 'second');
    expect({ runs: fs.readFileSync(path.join(worktree, 'review-runs.txt'), 'utf8'), status: x.db.batches.get(batch.id)?.status })
      .toEqual({ runs: 'x', status: 'review' });
  });

  it('batches: a new head runs the review command again after rejection', async () => {
    const x = setup();
    const batch = await batchReadyForReview(x);
    const worktree = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    x.db.repos.update('r1', { review_command: `node -e "require('fs').appendFileSync('review-runs.txt','x'); console.log('1 passed (1s)')"` });
    await x.lc.requestBatchReview('r1', batch.id, 'first');
    await x.lc.rejectBatch(batch.id, 'retry');
    const headSha = await commitFileAsync(worktree, 'new-head.txt', 'new\n', 'new head');
    await x.lc.requestBatchReview('r1', batch.id, 'second');
    expect({ runs: fs.readFileSync(path.join(worktree, 'review-runs.txt'), 'utf8'), head: x.db.batches.get(batch.id)?.review_check?.head_sha })
      .toEqual({ runs: 'xx', head: headSha });
  });

  it('batches: a failed GitLab review command does not push or open a merge request', async () => {
    const landBatch = vi.fn(async () => ({ ok: true as const, mrUrl: 'https://gitlab.example.com/group/repo/-/merge_requests/1' }));
    const provider: GitProvider = { land: async () => { throw new Error('unused'); }, landBatch };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    const batch = await batchReadyForReview(x);
    x.db.repos.update('r1', { review_command: `node -e "console.log('failed suite'); process.exit(1)"` });
    let error = '';
    try { await x.lc.requestBatchReview('r1', batch.id, 'note'); }
    catch (e) { error = (e as Error).message; }
    expect({ error, pushed: landBatch.mock.calls.length, status: x.db.batches.get(batch.id)?.status })
      .toMatchObject({ error: expect.stringContaining('exit code 1'), pushed: 0, status: 'open' });
  });

  it('batches: requestBatchReview stays open when the MR cannot be created', async () => {
    const failing: GitProvider = { land: async () => { throw new Error('unused'); }, landBatch: async () => { throw new Error('glab down'); } };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider: failing });
    await x.lc.createBatch('r1', 'Mr fails');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'note')).rejects.toThrow(/glab down/);
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'open', mr_url: null });
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'note')).rejects.toThrow(/glab down/);
  });

  it('batches: gitlab-mr re-request after a rejection hands the provider the existing MR and keeps its URL', async () => {
    const url = 'https://gitlab.example.com/g/p/-/merge_requests/396';
    const seen: (string | null)[] = [];
    const provider: GitProvider = { land: async () => { throw new Error('unused'); }, landBatch: async (_repo, batch) => { seen.push(batch.mr_url); return { ok: true, mrUrl: url }; } };
    const x = setup(undefined, 3, { mergeMode: 'gitlab-mr', provider });
    await x.lc.createBatch('r1', 'Mr twice');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'first');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', mr_url: url });
    await x.lc.rejectBatch('r1-b1', 'fix it');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'open', mr_url: url });
    expect(await x.lc.requestBatchReview('r1', 'r1-b1', 'second')).toEqual({ mrUrl: url, waitingOn: null, overlapFiles: null });
    expect(seen).toEqual([null, url]);
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', note: 'second', mr_url: url });
    expect(x.notes.at(-1)).toBe(`Batch r1-b1 is ready for review: ${url}`);
  });

  it('batches: abandon during verification does not reopen the bead', async () => {
    // Verification holds until the test opens the gate, so the abandon provably lands while it still runs.
    const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-gate-')), 'open').replace(/\\/g, '/');
    const x = setup(`node -e "setInterval(()=>{if(require('fs').existsSync('${gate}'))process.exit(0)},20)"`);
    await x.lc.createBatch('r1', 'Slow verify');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'verifying', WAIT, 'verifying');
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    try {
      await x.lc.abandonBatch('r1-b1');
      expect(await x.status()).toBe('closed');
      // The bead leaves the lifecycle's guarded set only once the verify run and everything it does afterwards has finished,
      // so a reopen that verification would make lands before this wait returns and fails the closed assertions below.
      const inFlight = (x.lc as unknown as { verifying: Set<string> }).verifying;
      expect(inFlight.has('ov-1')).toBe(true); // abandon returned while verification was still running
      fs.writeFileSync(gate, '');
      await until(() => !inFlight.has('ov-1'), 15000, 'delayed verification finished');
    } finally {
      error.mockRestore();
    }
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBeNull();
    expect(x.notes.at(-1)).toBe('Batch r1-b1 abandoned by the user');
  });

  it('batches: two beads finishing together both land (integration is serialised per batch)', async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Second' });
    await x.lc.createBatch('r1', 'Pair');
    const s1 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const s2 = await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'one.txt', '1\n', 'one');
    await commitFileAsync(x.db.worktrees.get('ov-2')!.path, 'two.txt', '2\n', 'two');
    x.finishTurn(s1);
    x.finishTurn(s2);
    const landed = () => x.notes.filter((n) => n.includes('landed on'));
    await until(() => landed().length === 2, WAIT, 'both landed');
    expect(await x.status('ov-1')).toBe('closed');
    expect(await x.status('ov-2')).toBe('closed');
    expect(await shAsync(x.repo.path, ['show', 'feature/pair:one.txt'])).toBe('1');
    expect(await shAsync(x.repo.path, ['show', 'feature/pair:two.txt'])).toBe('2');
    expect(landed()[1]).toMatch(/\(2\/2 beads done; verify command .* passed\)$/);
  });

  it('batches: an integration error reopens the bead with a note instead of stranding it', async () => {
    const x = setup(`node -e "setTimeout(()=>process.exit(0), 100)"`);
    await x.lc.createBatch('r1', 'Broken');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'a.txt', 'a\n', 'a');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'verifying', WAIT, 'verifying');
    await shAsync(x.repo.path, ['worktree', 'remove', '--force', batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1')]);
    await shAsync(x.repo.path, ['branch', '-D', 'feature/broken']);
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    try {
      await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    } finally {
      error.mockRestore();
    }
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Integration failed');
    expect(x.notes.at(-1)).toMatch(/^ov-1 reopened: integration into feature\/broken failed/);
  });

  it('batches: a bd list failure after the merge leaves the landed bead closed and merged; the notice still comes (fix round 15 review I-1)', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Counted');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'a.txt', 'a\n', 'a');
    // The count's `bd list` runs after the merge, the close and the worktree removal: its failure must not reopen the bead.
    vi.spyOn(x.store, 'list').mockRejectedValueOnce(new Error('bd list failed: database is locked'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    x.finishTurn(sid);
    try {
      await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
      expect(error.mock.calls.map((c) => c[0])).toContain('lifecycle: bd list failed for a batch count');
    } finally {
      error.mockRestore();
    }
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(x.db.worktrees.get('ov-1')?.merged_at).toEqual(expect.any(String));
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/counted (1/1 dispatched beads done; bd list failed, so beads never dispatched are not counted; verify command `node -e "process.exit(0)"` passed)');
    expect(x.notes.some((n) => n.includes('reopened'))).toBe(false);
  });

  it('batches: a bd list failure during Close bead does not fail the close, and the orchestrator still hears of it (fix round 15 review I-2)', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Two');
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Created, not dispatched', labels: ['overseer:batch:r1-b1'] });
    vi.spyOn(x.store, 'list').mockRejectedValueOnce(new Error('bd list failed: database is locked'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    try {
      await x.lc.closeBead('ov-2');
    } finally {
      error.mockRestore();
    }
    expect(await x.status('ov-2')).toBe('closed');
    expect(await x.phase('ov-2')).toBe('closed');
    expect(x.notes.at(-1)).toBe("ov-2 closed as won't do by the user from the Board; batch r1-b1 stays open (0/0 dispatched beads done; bd list failed, so beads never dispatched are not counted).");
    expect(x.wakes.at(-1)).toBe(x.notes.at(-1));
  });

  it('batches: abandon completes and notifies when the branch cannot be deleted', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Held');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    // Check the batch branch out in the primary repo so `git branch -D` is refused during cleanup.
    await shAsync(x.repo.path, ['worktree', 'remove', '--force', batchWorktreePath(x.worktreesDir, 'r1', 'r1-b1')]);
    await shAsync(x.repo.path, ['checkout', 'feature/held']);
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    try {
      await expect(x.lc.abandonBatch('r1-b1')).resolves.toBeUndefined();
      await until(() => x.db.sessions.get(sid)?.status !== 'running', WAIT, 'worker stopped');
    } finally {
      error.mockRestore();
    }
    expect(x.db.batches.get('r1-b1')?.status).toBe('abandoned');
    expect(x.db.worktrees.forBatch('r1-b1').map((w) => w.bead_id)).toEqual(['ov-1']); // the row stays; the folder is gone
    expect(x.notes.at(-1)).toBe('Batch r1-b1 abandoned by the user');
    await expect(x.lc.abandonBatch('r1-b1')).rejects.toThrow(/is abandoned/);
  });

  it('batches: a merge conflict keeps the batch in review until the user rejects it', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Clash main');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'README.md', '# bead\n', 'bead side');
    await commitFileAsync(x.repo.path, 'README.md', '# main\n', 'main side');
    x.finishTurn(sid);
    await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'note');
    await expect(x.lc.mergeBatch('r1-b1')).rejects.toBeInstanceOf(MergeConflictError);
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'review', conflict_files: ['README.md'] });
    expect(x.notes.at(-1)).toMatch(/conflicted in: README.md\. The batch stays in review until the user rejects it/);
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Rebase' });
    await expect(x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b1' })).rejects.toThrow(/is review/);
    await x.lc.rejectBatch('r1-b1', 'rebase onto main');
    expect(x.db.batches.get('r1-b1')).toMatchObject({ status: 'open', conflict_files: null });
    await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b1' });
    expect(x.db.worktrees.get('ov-2')?.batch_id).toBe('r1-b1');
  });

  it('batches: a re-dispatch without batch_id keeps the bead in its batch', async () => {
    const x = setup(`node -e "process.exit(1)"`);
    await x.lc.createBatch('r1', 'Keep');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    const sid2 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', instructions: 'fix the test' });
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ batch_id: 'r1-b1', base_branch: 'feature/keep' });
    expect(x.fake.sent(x.sessions.handleOf(sid2)!)[0]).toContain('based on `feature/keep`');
  });

  it('batches: a bead created for a batch is dispatched into that batch by default and refused for another (fix round 15 review M-2)', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'First');
    await x.lc.createBatch('r1', 'Second');
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Created for the first', labels: ['overseer:batch:r1-b1'] });
    await expect(x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b2' })).rejects.toThrow(/bead ov-2 was created for batch r1-b1; dispatch it there or create a new bead for r1-b2/);
    expect(x.db.worktrees.get('ov-2')).toBeUndefined();
    await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude' });
    expect(x.db.worktrees.get('ov-2')).toMatchObject({ batch_id: 'r1-b1', base_branch: 'feature/first' });
  });

  it("batches: a failing bd ready after a close says the dependents may be ready instead of claiming they are blocked (fix round 15 review M-4)", async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Waits' }, ['ov-1']);
    vi.spyOn(x.store, 'ready').mockRejectedValueOnce(new Error('bd ready failed: locked'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    try {
      await x.lc.closeBead('ov-1');
      expect(error.mock.calls[0]?.[0]).toBe('lifecycle: bd ready failed after a close');
    } finally {
      error.mockRestore();
    }
    expect(x.notes.at(-1)).toBe("ov-1 closed as won't do by the user from the Board; ov-4 waited on it and may be ready in bd now (bd ready failed).");
  });
  it('batches: a bd close failure after the merge leaves the bead landed but unclosed; Retry close and the restart sweep close it (fix round 16 review N16-1)', async () => {
    const x = setup();
    const b = await x.lc.createBatch('r1', 'Recorded');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: b.id });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'a.txt', 'a\n', 'a');
    vi.spyOn(x.store, 'close').mockRejectedValueOnce(new Error('bd close failed: database is locked'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    x.finishTurn(sid);
    try {
      await until(() => x.notes.at(-1)?.includes('could not record it') ?? false, WAIT, 'reported');
    } finally {
      error.mockRestore();
    }
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/recorded but bd could not record it: bd close failed: database is locked. Its work is merged; do not re-dispatch it.');
    expect(x.hints.at(-1)).toMatch(/Retry close/);
    // The row knows the bead landed, bd still has it in Verifying, and the card says so instead of parking it with no action.
    expect(x.db.worktrees.get('ov-1')?.merged_at).toEqual(expect.any(String));
    expect(await x.status()).toBe('in_progress');
    expect(await x.phase()).toBe('verifying');
    const card = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(card).toMatchObject({ column: 'verifying', state: 'landed_unclosed', batch_id: b.id });
    await expect(x.lc.closeBead('ov-1')).rejects.toThrow(/busy/);
    // Retry close from the card.
    await x.lc.closeLanded('ov-1');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/recorded (1/1 beads done; verify command `node -e "process.exit(0)"` passed)');
    await expect(x.lc.closeLanded('ov-1')).rejects.toThrow('ov-1 is already recorded as landed');
    expect(x.notes.some((n) => n.includes('reopened'))).toBe(false);
  });

  it('batches: recover closes a landed bead bd has not closed (fix round 16 review N16-1)', async () => {
    const x = setup();
    const b = await x.lc.createBatch('r1', 'Swept');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: b.id });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    vi.spyOn(x.store, 'close').mockRejectedValueOnce(new Error('bd close failed'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    x.finishTurn(sid);
    try {
      await until(() => x.notes.at(-1)?.includes('could not record it') ?? false, WAIT, 'reported');
    } finally {
      error.mockRestore();
    }
    await x.lc.recover();
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(x.notes.at(-1)).toMatch(/^ov-1 landed on feature\/swept \(1\/1 beads done/);
    await expect(x.lc.closeLanded('ov-2')).rejects.toThrow('ov-2 has not landed on a batch branch');
  });

  it('batches: recover closes a landed bead bd closed but did not mark merged (fix round 17 review N17-1)', async () => {
    const x = setup();
    const b = await x.lc.createBatch('r1', 'Halfway');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: b.id });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'a.txt', 'a\n', 'a');
    // bd fails on the *second* call of the landing (the phase write), so the bead is closed while its phase still reads verifying.
    const update = x.store.update.bind(x.store);
    let failed = false;
    vi.spyOn(x.store, 'update').mockImplementation(async (p, id, patch) => {
      if (!failed && patch.phase === 'merged') { failed = true; throw new Error('bd update failed: database is locked'); }
      return update(p, id, patch);
    });
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    x.finishTurn(sid);
    try {
      await until(() => x.notes.at(-1)?.includes('could not record it') ?? false, WAIT, 'reported');
    } finally {
      error.mockRestore();
    }
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('verifying');
    expect(fs.existsSync(wt.path)).toBe(true);
    await x.lc.recover();
    expect(await x.phase()).toBe('merged');
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.notes.at(-1)).toMatch(/^ov-1 landed on feature\/halfway \(1\/1 beads done/);
  });

  it('batches: a label naming a batch this database lacks is inert: no membership, no refusal, logged once (round 17 R17-1)', async () => {
    const x = setup();
    const b = await x.lc.createBatch('r1', 'Fresh');
    // Left in the repo's .beads by an earlier install whose data dir was reset (or a removed repo): the label names a batch this database never had.
    x.store.add(x.repo.path, { id: 'ov-2', title: 'From the old install', labels: ['overseer:batch:r1-b1-old1'] });
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Also old', labels: ['overseer:batch:r1-b1-old1'] });
    expect(batchSummaries(x.db, 'r1', await x.store.list(x.repo.path))[0]).toMatchObject({ id: b.id, beads_total: 0, beads_closed: 0 });
    const warn = scopedSpy(console, 'warn').mockImplementation(() => {});
    try {
      await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: b.id }); // not "was created for batch r1-b1-old1"
      expect(x.db.worktrees.get('ov-2')).toMatchObject({ batch_id: b.id });
      await x.lc.closeBead('ov-3');
      expect(warn.mock.calls.map((c) => c[0])).toEqual(['lifecycle: ignoring label overseer:batch:r1-b1-old1 on ov-2: no batch r1-b1-old1 in this database']);
    } finally {
      warn.mockRestore();
    }
    expect(x.notes.at(-1)).toBe("ov-3 closed as won't do by the user from the Board.");
  });

  it('batches: a never-dispatched bead labelled for a batch that is no longer open can be closed from the Board, and the dispatch refusal says so (fix round 16 review item 3)', async () => {
    const x = setup();
    const first = await x.lc.createBatch('r1', 'First');
    const second = await x.lc.createBatch('r1', 'Second');
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Created for the first', labels: [`overseer:batch:${first.id}`] });
    x.db.batches.update(first.id, { status: 'merged' });
    await expect(x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: second.id })).rejects.toThrow(`bead ov-2 was created for batch ${first.id}, which is merged; create a new bead for ${second.id}, and close this one from the Board (Close bead) if it is no longer wanted`);
    await x.lc.closeBead('ov-2', 'stale');
    expect(await x.status('ov-2')).toBe('closed');
    expect(x.notes.at(-1)).toBe(`ov-2 closed as won't do by the user from the Board: stale; its batch ${first.id} is merged.`);
    expect(x.wakes).not.toContain(x.notes.at(-1));
    // A batch in review is named the way every other daemon line names it, not with the bare status word (fix round 19 review NB-5).
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Created for the second', labels: [`overseer:batch:${second.id}`] });
    x.db.batches.update(second.id, { status: 'review' });
    await x.lc.closeBead('ov-3');
    expect(x.notes.at(-1)).toBe(`ov-3 closed as won't do by the user from the Board; its batch ${second.id} is in review (awaiting the user's review, not merged).`);
  });
  it('tiers: a tier resolves to a harness and model, steps up past a failed model, and a forced harness takes that harness\'s candidate', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra', tier: 'standard' });
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 }); // no commits: the bead reopens and the session ends
    await until(() => x.db.sessions.get(sid)!.status !== 'running');
    // The next attempt skips terra (already tried on this bead) and, stepping up, takes the hard tier's first fresh model.
    const sid2 = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', stepUp: true });
    expect(x.db.sessions.get(sid2)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol', tier: 'standard' }); // the row keeps the requested tier; the step-up shows in the model
    x.codex.emit(x.sessions.handleOf(sid2)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.1 });
    await until(() => x.db.sessions.get(sid2)!.status !== 'running');
    const sid3 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    // The forced harness scans its own candidates across the standard, chore and hard tier, so it records the model it picked as well as the account.
    expect(x.db.sessions.get(sid3)).toMatchObject({ harness: 'claude', model: 'sonnet', account: null, tier: null });
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Re-dispatched to claude');
  });

  it('tiers: a forced opencode harness scans the standard, chore and hard tiers, recording the DeepSeek account and model for opencode', async () => {
    const x = setup();
    // The default tiers list codex and claude only; the opencode candidate sits in hard, so resolution scans the standard, chore, then hard tier and takes the first opencode candidate in that order.
    x.db.accounts.insert({ id: 'oc-deepseek', name: 'DeepSeek', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'sk-deepseek', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    tiers.tiers.find((t) => t.name === 'hard')!.candidates = [{ harness: 'opencode', model: 'deepseek-reasoner', effort: 'high', account: 'oc-deepseek' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'opencode', model: 'deepseek-reasoner', account: 'oc-deepseek', tier: null });
    // The chosen model, effort and account are what the harness process runs with, not just row fields (the row has no effort column).
    const opts = x.opencode.sessions.get(x.sessions.handleOf(sid)!.id)!.opts;
    expect(opts.model).toBe('deepseek-reasoner');
    expect(opts.effort).toBe('high');
    expect(opts.env).toEqual({ DEEPSEEK_API_KEY: 'sk-deepseek' });
  });

  it('tiers: a forced harness with no tier candidate keeps the CLI default, recording a null model and account', async () => {
    const warn = scopedSpy(log, 'warn');
    const x = setup(); // the default tiers list codex and claude only
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'opencode', model: null, account: null, tier: null });
    // The degraded fallback says it keeps the CLI default model and login, not a pinned model.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable opencode candidate'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('default model and the CLI login'));
  });

  it('tiers: a forced claude harness falls back to the next usable account of its harness', async () => {
    const x = setup(undefined, 3, { usageGate: async (_db, _config, accountId) => (accountId === 'c1' ? { usable: false, reason: 'c1 exhausted' } : { usable: true }) });
    for (const id of ['c1', 'c2']) x.db.accounts.insert({ id, name: id, harness: 'claude', kind: 'oauth_token', secret: `token-${id}`, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'c1' }, { harness: 'claude', model: 'sonnet', effort: null, account: 'c2' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'c2', tier: null });
    expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'token-c2' });
  });

  it('tiers: a forced claude harness with a pinned model gates a candidate on that model, not its tier-configured one', async () => {
    // c1 is usable for its tier-configured model, sonnet, but the dispatch pins opus (a crash or review retry keeping the
    // prior model): gating on sonnet would wrongly select c1 for a session that actually runs opus at the threshold.
    const warn = scopedSpy(log, 'warn');
    const x = setup(undefined, 3, { usageGate: async (_db, _config, accountId, model) => (accountId === 'c1' && model === 'opus' ? { usable: false, reason: 'c1 at the threshold for opus' } : { usable: true }) });
    x.db.accounts.insert({ id: 'c1', name: 'c1', harness: 'claude', kind: 'oauth_token', secret: 'token-c1', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) {
      if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'c1' }];
      // The default chore and hard tiers also carry account-less claude candidates; remove them so c1 is the only one a
      // forced claude dispatch could take and its opus refusal leaves no candidate at all.
      if (tier.name === 'chore' || tier.name === 'hard') tier.candidates = tier.candidates.filter((c) => c.harness !== 'claude');
    }
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: 'opus' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'opus', account: null, tier: null });
    // A pinned retry with no usable candidate keeps the pinned model, not the CLI default, and the warning must say so.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pinned opus model'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('default model'));
  });

  it('tiers: a forced claude harness skips a candidate whose account has no authorization yet', async () => {
    const x = setup();
    // An OAuth account exists from creation, before its token is stored: it is not runnable, so the next candidate with a usable account must be taken.
    x.db.accounts.insert({ id: 'pending', name: 'Claude Pending', harness: 'claude', kind: 'oauth_token', secret: null, home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    x.db.accounts.insert({ id: 'ready', name: 'Claude Ready', harness: 'claude', kind: 'oauth_token', secret: 'token-ready', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'pending' }, { harness: 'claude', model: 'sonnet', effort: null, account: 'ready' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'ready', tier: null });
    expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'token-ready' });
  });

  it('tiers: a forced harness skips a candidate whose stored Claude token can no longer be refreshed, taking the next account', async () => {
    const x = setup();
    const requests: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
        res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"invalid_grant"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    try {
      // A revoked authorization leaves the stale access token stored, so `accountLoggedIn` alone reads the account as usable;
      // only the refresh a session start performs fails, and selection must skip it before the worktree is prepared.
      x.db.accounts.insert({ id: 'revoked', name: 'Revoked Claude', harness: 'claude', kind: 'oauth_token', secret: 'revoked-stale-access', refresh_token: 'revoked-refresh', token_expires_at: Date.now() - 1, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      x.db.accounts.insert({ id: 'ready', name: 'Ready Claude', harness: 'claude', kind: 'oauth_token', secret: 'ready-access', refresh_token: null, token_expires_at: null, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'revoked' }, { harness: 'claude', model: 'sonnet', effort: null, account: 'ready' }];
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'ready', tier: null });
      expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'ready-access' });
      expect(requests.some((request) => request.refresh_token === 'revoked-refresh')).toBe(true);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('tiers: a forced claude harness whose only account has no authorization runs on the CLI login instead of failing', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'pending', name: 'Claude Pending', harness: 'claude', kind: 'oauth_token', secret: null, home: null, created_at: 't0', last_login_at: null, last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name !== 'critic') tier.candidates = tier.candidates.map((c) => (c.harness === 'claude' ? { ...c, account: 'pending' } : c));
    x.db.settings.set('tiers', tiers);
    const warn = scopedSpy(log, 'warn');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: null, account: null, tier: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable claude candidate'));
  });

  it('tiers: a forced harness stays on the CLI login, a degraded session rather than a failed one, when every candidate of it is exhausted', async () => {
    const x = setup(undefined, 3, { usageGate: async () => ({ usable: false, reason: 'every account exhausted' }) });
    x.db.accounts.insert({ id: 'c1', name: 'c1', harness: 'claude', kind: 'oauth_token', secret: 'token-c1', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name !== 'critic') tier.candidates = tier.candidates.map((c) => (c.harness === 'claude' ? { ...c, account: 'c1' } : c));
    x.db.settings.set('tiers', tiers);
    const warn = scopedSpy(log, 'warn');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: null, account: null, tier: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable claude candidate'));
  });

  it('tiers: carries a forced harness account in the worker\'s environment only, never into the repository or a notice', async () => {
    const x = setup();
    const secret = 'oauth-token-must-not-leak';
    x.db.accounts.insert({ id: 'cw', name: 'Claude Work', harness: 'claude', kind: 'oauth_token', secret, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'cw' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    // The authorization reaches the worker process through its environment, and only there.
    expect(x.fake.sessions.get(x.sessions.handleOf(sid)!.id)!.opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: secret, ANTHROPIC_API_KEY: undefined });
    // No file in the worktree the worker commits from, and no notice the daemon posts, carries it.
    const wt = x.db.worktrees.get('ov-1')!;
    for (const rel of fs.readdirSync(wt.path, { recursive: true })) {
      const p = path.join(wt.path, String(rel));
      if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain(secret);
    }
    expect(x.notes.some((n) => n.includes(secret))).toBe(false);
  });

  it('tiers: keeps the forced harness authorization out of the session log the daemon keeps and out of argv', async () => {
    const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-forced-argv-')), 'argv.json');
    const marker = 'the-fake-claude-process-output';
    const { bin } = fakeBin('fake-claude-session-log', [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));`,
      "process.stdin.resume();",
      `process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: marker }] } }))}); });`,
      "process.stdin.on('end', () => process.exit(0));",
    ].join('\n'));
    // A real adapter writing a real session log: the daemon's log file is the harness process's own stdout.
    const x = setup(undefined, 3, { claudeAdapter: new ClaudeAdapter(bin, 10) });
    const secret = 'oauth-token-must-not-leak';
    x.db.accounts.insert({ id: 'cw', name: 'Claude Work', harness: 'claude', kind: 'oauth_token', secret, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'cw' }];
    x.db.settings.set('tiers', tiers);
    let sid: string | undefined;
    try {
      sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      const row = x.db.sessions.get(sid)!;
      expect(row).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'cw', tier: null });
      const logPath = row.log_path!;
      await until(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(marker), WAIT, 'the session log with the process output');
      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toContain(marker); // the assertion is on a real, non-empty log, not a file that happens to be missing
      expect(log).not.toContain(secret);
      // The authorization travels by environment, never by argv.
      await until(() => fs.existsSync(argvFile), WAIT, 'the process arguments');
      expect(fs.readFileSync(argvFile, 'utf8')).not.toContain(secret);
    } finally {
      if (sid) await x.sessions.interrupt(sid).catch(() => { /* the process already ended */ });
    }
  });

  it('tiers: no tier and no harness means standard', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1');
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra', tier: 'standard' });
  });

  it('tiers: starts a worker with the selected account environment', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Work Codex', harness: 'codex', kind: 'codex_home', home: 'C:/accounts/a1', created_at: 't0', last_login_at: 't1', last_verified_at: null });
    x.db.settings.set('tiers', {
      tiers: [
        { name: 'chore', candidates: [{ harness: 'codex', model: 'luna', effort: null, account: 'a1' }] },
        { name: 'standard', candidates: [{ harness: 'codex', model: 'terra', effort: null, account: 'a1' }] },
        { name: 'hard', candidates: [{ harness: 'codex', model: 'sol', effort: null, account: 'a1' }] },
        { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
      ],
      denyModels: [],
    });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)?.account).toBe('a1');
    const h = x.sessions.handleOf(sid)!;
    expect(x.codex.sessions.get(h.id)!.opts.env).toEqual({ CODEX_HOME: 'C:/accounts/a1' });
  });

  it('tiers: reopens the bead without a worktree when the selected account is not logged in', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Work Codex', label: 'Work', harness: 'codex', kind: 'codex_home', home: 'C:/accounts/a1', created_at: 't0', last_login_at: null, last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: 'a1' }];
    x.db.settings.set('tiers', tiers);
    await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' })).rejects.toThrow('account Work Codex (Work) is not logged in');
    expect(await x.status()).toBe('open');
    expect(x.db.worktrees.get('ov-1')).toBeUndefined();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Account Work Codex (Work) is not logged in');
    expect(x.wakes.at(-1)).toBe('ov-1 was not dispatched: account Work Codex (Work) is not logged in.');
    x.db.accounts.update('a1', { label: null });
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Unlabelled account' });
    await expect(x.lc.spawnWorker('r1', 'ov-2', { tier: 'standard' })).rejects.toThrow('account Work Codex is not logged in');
    expect(x.wakes.at(-1)).toBe('ov-2 was not dispatched: account Work Codex is not logged in.');
  });

  it('tiers: leaves a bead Ready and posts one notice when every account is usage-gated', async () => {
    const x = setup(undefined, 3, { usageGate: async () => ({ usable: false, reason: 'account Work Account: weekly 96% >= 95%' }) });
    x.db.accounts.insert({ id: 'a1', name: 'Work Account', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account: 'a1' }];
    x.db.settings.set('tiers', tiers);
    await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' })).rejects.toThrow('no usable account for tier standard: account Work Account: weekly 96% >= 95%');
    expect(await x.status()).toBe('open');
    expect(x.db.worktrees.get('ov-1')).toBeUndefined();
    expect(x.notes).toEqual(['no usable account for tier standard: account Work Account: weekly 96% >= 95%']);
    await expect(x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' })).rejects.toThrow('no usable account');
    expect(x.notes).toHaveLength(1);
  });

  it('rate limit: exhausts the worker account and re-dispatches without a step-up or avoided model', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true });
    const x = setup(undefined, 3, { usageGate });
    for (const id of ['a1', 'a2']) x.db.accounts.insert({ id, name: `Claude ${id}`, harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account: 'a1' }, { harness: 'claude', model: 'fable', effort: null, account: 'a2' }];
    x.db.settings.set('tiers', tiers);
    const command = `node -e "console.log('Tests 2 passed (2)')"`;
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', verifyOnly: true, verifyCommand: command });
    x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-17T10:00:00.000Z', raw: {} });
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'rate-limit re-dispatch');
    expect(x.db.accounts.get('a1')?.exhausted_until).toBe(Date.parse('2026-09-17T10:00:00.000Z'));
    expect(x.db.sessions.forBead('ov-1').map((s) => [s.tier, s.model, s.account])).toEqual([['standard', 'fable', 'a1'], ['standard', 'fable', 'a2']]);
    expect(x.db.worktrees.get('ov-1')?.review_round).toBeNull();
    expect(x.notes.at(-1)).toMatch(/^ov-1 re-dispatched: account Claude a1 exhausted until .+, now on Claude a2\.$/);
    expect(usageGate.mock.calls.filter((call) => call[2] === 'a2' && call[3] === 'fable').length).toBeGreaterThan(1);
    const retry = x.db.sessions.forBead('ov-1')[1]!;
    x.fake.emit(x.sessions.handleOf(retry.id)!, { type: 'turn_end', nativeSessionId: 'rate-limit-retry', cost: 0 });
    await until(async () => x.db.worktrees.get('ov-1')?.verify_only_result?.status === 'pass' && await x.phase() === 'verified', WAIT, 'rate-limit retry closes as verified');
    expect({ verifyOnly: retry.verify_only, command: x.db.worktrees.get('ov-1')?.verify_command, result: x.db.worktrees.get('ov-1')?.verify_only_result, phase: await x.phase() }).toMatchObject({
      verifyOnly: 1, command, result: { status: 'pass', command, exit_code: 0 }, phase: 'verified',
    });
  });

  it('rate limit: a forced harness re-dispatches on the next account of that CLI, not through the standard tier', async () => {
    const x = setup(undefined, 3, { usageGate: async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true } });
    for (const id of ['a1', 'a2']) x.db.accounts.insert({ id, name: `Claude ${id}`, harness: 'claude', kind: 'oauth_token', secret: `token-${id}`, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    // The standard tier is Codex-first: a re-dispatch through it would land on codex and lose the forced harness and the
    // account a forced claude worker needs for its plugin MCP servers.
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }, { harness: 'claude', model: 'sonnet', effort: null, account: 'a1' }, { harness: 'claude', model: 'sonnet', effort: null, account: 'a2' }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(first)).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'a1', tier: null });
    x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-17T10:00:00.000Z', raw: {} });
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'forced rate-limit re-dispatch');
    expect(x.db.accounts.get('a1')?.exhausted_until).toBe(Date.parse('2026-09-17T10:00:00.000Z'));
    expect(x.db.sessions.forBead('ov-1').map((s) => [s.tier, s.harness, s.model, s.account])).toEqual([[null, 'claude', 'sonnet', 'a1'], [null, 'claude', 'sonnet', 'a2']]);
    expect(x.notes.at(-1)).toMatch(/^ov-1 re-dispatched: account Claude a1 exhausted until .+, now on Claude a2\.$/);
  });

  it('rate limit: a tiered worker re-dispatches through its own tier, not the harness it ran on', async () => {
    const x = setup(undefined, 3, { usageGate: async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true } });
    x.db.accounts.insert({ id: 'a1', name: 'Claude a1', harness: 'claude', kind: 'oauth_token', secret: 'token-a1', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    // The exhausted session ran on the tier's first candidate (claude a1); the tier re-dispatch skips the exhausted account and
    // goes back through resolveTier to codex, rather than staying on the claude harness the session happened to run on.
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'a1' }, { harness: 'codex', model: 'gpt-5.6-terra', effort: null }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(first)).toMatchObject({ tier: 'standard', harness: 'claude', model: 'sonnet', account: 'a1' });
    x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-17T10:00:00.000Z', raw: {} });
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'tiered rate-limit re-dispatch');
    expect(x.db.sessions.forBead('ov-1').map((s) => [s.tier, s.harness, s.model, s.account])).toEqual([['standard', 'claude', 'sonnet', 'a1'], ['standard', 'codex', 'gpt-5.6-terra', null]]);
  });

  it('rate limit: a forced harness with no usable candidate left starts degraded on the CLI login', async () => {
    const warn = scopedSpy(log, 'warn');
    const x = setup(undefined, 3, { usageGate: async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true } });
    x.db.accounts.insert({ id: 'a1', name: 'Claude a1', harness: 'claude', kind: 'oauth_token', secret: 'token-a1', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    // Every claude candidate points at a1, so once it is exhausted the forced route has no candidate left at all.
    for (const tier of tiers.tiers) if (tier.name !== 'critic') tier.candidates = tier.candidates.map((c) => (c.harness === 'claude' ? { ...c, account: 'a1' } : c));
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(first)).toMatchObject({ harness: 'claude', model: 'sonnet', account: 'a1', tier: null });
    x.fake.emit(x.sessions.handleOf(first)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-17T10:00:00.000Z', raw: {} });
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'degraded forced re-dispatch');
    // The replacement still starts, keeping the forced CLI and no tier, on that CLI's own login, instead of failing.
    expect(x.db.sessions.forBead('ov-1').find((s) => s.status === 'running')).toMatchObject({ harness: 'claude', tier: null, account: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable claude candidate'));
  });

  it('usage limit: a codex session ending on its usage limit holds codex until the reset, then frees it', async () => {
    const x = setup();
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }, { harness: 'claude', model: 'sonnet', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(first)?.harness).toBe('codex');
    const message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 20th, 2099 12:18 PM.";
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message });
    x.codex.emit(h, { type: 'error', message });
    await x.codex.end(h);
    await until(() => (x.db.settings.get('harness_limits') as Record<string, number> | undefined)?.codex === reset.getTime(), WAIT, 'codex held');
    expect(x.notes).toContain(`codex hit its usage limit in session ${first}; it is skipped until ${reset.toISOString()}.`);
    expect(x.hints).toContain('Dispatches skip this harness until then; pick another harness or wait.');
    // The next candidate of the same tier takes the work over instead of the bead waiting for the reset.
    await until(() => x.db.sessions.forBead('ov-1').some((s) => s.status === 'running' && s.harness === 'claude'), WAIT, 'codex re-dispatched');
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Next' });
    const second = await x.lc.spawnWorker('r1', 'ov-2', { tier: 'standard' });
    expect(x.db.sessions.get(second)?.harness).toBe('claude');
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Forced' });
    await expect(x.lc.spawnWorker('r1', 'ov-3', { harness: 'codex' })).rejects.toThrow(`codex: usage limit until ${reset.toISOString()}`);
    // The hold lapses: move the reset into the past instead of mocking Date.now, which would expire the deadlines of the
    // tests running concurrently with this one.
    x.db.settings.set('harness_limits', { codex: Date.now() - 1 });
    const third = await x.lc.spawnWorker('r1', 'ov-3', { tier: 'standard' });
    expect(x.db.sessions.get(third)?.harness).toBe('codex');
  });

  it('usage limit: re-dispatches a worker that ended on one to the next candidate of its tier', async () => {
    const x = setup();
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }, { harness: 'claude', model: 'sonnet', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const command = `node -e "console.log('Tests 6 passed (6)')"`;
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', verifyOnly: true, verifyCommand: command });
    expect(x.db.sessions.get(first)?.harness).toBe('codex');
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message: 'usage limit' });
    x.codex.emit(h, { type: 'error', message: 'exceeded retry limit' });
    await x.codex.end(h);
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'usage-limit re-dispatch');
    expect(x.db.sessions.forBead('ov-1').map((s) => [s.tier, s.harness, s.model])).toEqual([['standard', 'codex', 'terra'], ['standard', 'claude', 'sonnet']]);
    expect(x.db.sessions.get(first)?.status).toBe('failed'); // the limit killed it; it is not settled as a no-commit reopen
    expect((x.db.settings.get('harness_limits') as Record<string, number>).codex).toBe(reset.getTime());
    expect(x.notes.at(-1)).toMatch(/^ov-1 re-dispatched: codex exhausted until .+, now on claude\.$/);
    const retry = x.db.sessions.forBead('ov-1')[1]!;
    x.fake.emit(x.sessions.handleOf(retry.id)!, { type: 'turn_end', nativeSessionId: 'usage-limit-retry', cost: 0 });
    await until(async () => x.db.worktrees.get('ov-1')?.verify_only_result?.status === 'pass' && await x.phase() === 'verified', WAIT, 'usage-limit retry closes as verified');
    expect({ verifyOnly: retry.verify_only, command: x.db.worktrees.get('ov-1')?.verify_command, result: x.db.worktrees.get('ov-1')?.verify_only_result, phase: await x.phase() }).toMatchObject({
      verifyOnly: 1, command, result: { status: 'pass', command, exit_code: 0 }, phase: 'verified',
    });
  });

  it('usage limit: a worker the user stopped is not re-dispatched after it logged one, and the limit is still held', async () => {
    const x = setup();
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }, { harness: 'claude', model: 'sonnet', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(first)?.harness).toBe('codex');
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message: 'usage limit' });
    // The limit was logged but the CLI has not exited yet when the user presses Stop on the Board; the stop wins over the re-dispatch.
    await x.lc.interruptBead('ov-1');
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened after the stop');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
    expect(x.db.sessions.get(first)?.status).toBe('ended');
    expect(x.notes.at(-1)).toBe('ov-1 stopped by the user from the Board; reopened without new commits.');
    expect(x.hints.at(-1)).toBe('Do not re-dispatch it unless the user asks.');
    expect((x.db.settings.get('harness_limits') as Record<string, number>).codex).toBe(reset.getTime());
  });

  it('usage limit: a batch abandoned before the session ends is not resurrected by a re-dispatch', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Doomed');
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }, { harness: 'claude', model: 'sonnet', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    expect(x.db.sessions.get(first)?.harness).toBe('codex');
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: new Date(2099, 8, 20, 12, 18).toISOString(), message: 'usage limit' });
    await x.lc.abandonBatch('r1-b1'); // marks the batch first, then interrupts the session
    await until(() => x.db.sessions.get(first)?.status !== 'running', WAIT, 'session stopped');
    // Drain the fire-and-forget usage-limit settle; the abandoned batch must win over a re-dispatch.
    await new Promise((resolve) => setImmediate(resolve));
    expect(x.db.signals.forBatch('r1-b1')).toEqual([]); // no reopen signal for a batch that was never reopened
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('abandoned');
    expect(x.notes.some((n) => n.includes('no usable account left'))).toBe(false);
  });

  it('usage limit: with no candidate left the bead stays Ready and the notice names the harness and its reset', async () => {
    const x = setup();
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message: 'usage limit' });
    x.codex.emit(h, { type: 'error', message: 'exceeded retry limit' });
    await x.codex.end(h);
    await until(() => x.notes.some((n) => n.includes('no usable account left')), WAIT, 'waiting notice');
    expect(await x.status()).toBe('open');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
    expect((x.db.settings.get('harness_limits') as Record<string, number>).codex).toBe(reset.getTime());
    expect(x.notes.at(-1)).toMatch(/^ov-1 re-dispatched: codex exhausted until .+, no usable account left; waiting\.$/);
    expect(x.wakes).toContain(x.notes.at(-1));
  });

  it('usage limit: an unreadable reset time holds the harness for one hour and says so', async () => {
    const x = setup();
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    const h = x.sessions.handleOf(first)!;
    const before = Date.now();
    x.codex.emit(h, { type: 'usage_limit', resetsAt: null, message: 'You hit your usage limit. Try again later.' });
    await x.codex.end(h);
    await until(() => x.notes.some((n) => n.includes('usage limit')), WAIT, 'usage-limit notice');
    const until1 = (x.db.settings.get('harness_limits') as Record<string, number>).codex!;
    expect(until1).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(until1).toBeLessThan(before + 61 * 60 * 1000);
    expect(x.notes.find((n) => n.includes('usage limit'))).toContain('the reset time could not be read from "You hit your usage limit. Try again later.", so it is held for one hour');
  });

  it('usage limit: a codex session on an account exhausts that account', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'a1', name: 'Work Codex', harness: 'codex', kind: 'codex_home', home: 'C:/accounts/a1', created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const first = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'codex' });
    x.db.sessions.update(first, { account: 'a1' });
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: '2099-01-01T00:00:00.000Z', message: 'usage limit' });
    await x.codex.end(h);
    await until(() => x.db.accounts.get('a1')?.exhausted_until === Date.parse('2099-01-01T00:00:00.000Z'), WAIT, 'account exhausted');
    expect(x.db.settings.get('harness_limits')).toBeUndefined();
    expect(x.notes).toContain(`codex account Work Codex hit its usage limit in session ${first}; it is skipped until 2099-01-01T00:00:00.000Z.`);
    // Only the account is held, so the hint must not steer the orchestrator away from the whole harness.
    expect(x.hints).toContain("Dispatches skip account Work Codex until then; this harness's other accounts and the CLI's own login stay usable.");
  });

  it('rate limit: an allowed Claude usage update leaves the worker running', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    // `parseClaudeLine` drops Claude's recorded `status: allowed` rate_limit_event, so the lifecycle receives no rate_limit event.
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'raw', line: JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(x.db.sessions.get(sid)?.status).toBe('running');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1);
  });

  it('rate limit: a delayed end of the stopped session cannot settle over its replacement', async () => {
    const x = setup();
    const old = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    x.fake.emit(x.sessions.handleOf(old)!, { type: 'turn_end', nativeSessionId: 'old', cost: 0 });
    await until(() => x.db.sessions.get(old)?.status === 'ended', WAIT, 'old session ended');
    await until(async () => (await x.status()) === 'open', WAIT, 'old session settled');
    const replacement = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    // Model the rate-limit handler completing before its old consume loop emits session:ended.
    (x.lc as unknown as { rateLimits: Map<string, unknown> }).rateLimits.set(old, {});
    x.bus.emit('session:ended', { session: x.db.sessions.get(old)!, lastText: null, lastError: null, files: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(x.db.sessions.get(replacement)?.status).toBe('running');
    expect(await x.status()).toBe('in_progress');
  });

  it('rate limit: leaves the bead Ready and posts one waiting notice when no account is usable', async () => {
    const x = setup(undefined, 3, { usageGate: async () => ({ usable: false, reason: 'account a1 exhausted' }) });
    x.db.accounts.insert({ id: 'a1', name: 'Claude a1', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account: 'a1' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    x.db.sessions.update(sid, { tier: 'standard', model: 'fable', account: 'a1' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'rate_limit', kind: 'rate_limit', bucket: null, resetsAt: null, raw: {} });
    await until(async () => (await x.status()) === 'open' && x.notes.length === 1, WAIT, 'rate-limit waiting');
    expect(x.notes[0]).toMatch(/no usable account left; waiting\.$/);
    expect(x.wakes).toEqual(x.notes);
  });

  const parkedGate = async (db: ReturnType<typeof openDb>, _config: unknown, accountId: string) => {
    const account = db.accounts.get(accountId);
    return account?.exhausted_until && account.exhausted_until > Date.now() ? { usable: false as const, reason: `account ${account.name}: authentication failed; log in again` } : { usable: true as const };
  };

  it('auth: a rolled-over token resumes the same worker session on the refreshed account, without parking it', async () => {
    const x = setup();
    const first = Date.now() + 3 * 60 * 60_000;
    x.db.accounts.insert({ id: 'rollover', name: 'Rollover Claude', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'r', token_expires_at: first, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'rollover');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ account: 'rollover', token_expires_at: first });
    // Another session refreshed the account after this one started: its stored expiry no longer matches the session's.
    const refreshed = first + 60_000;
    x.db.accounts.update('rollover', { secret: 'fresh-access', token_expires_at: refreshed });
    emitAuthTurn(x, sid, 'native-roll');
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker' && s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'resumed worker');
    const resumed = x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)!;
    expect(resumed).toMatchObject({ native_session_id: 'native-roll', account: 'rollover', status: 'running', token_expires_at: refreshed });
    expect(x.fake.sessions.get(x.sessions.handleOf(resumed.id)!.id)!.opts.resumeId).toBe('native-roll');
    expect(await x.status()).toBe('in_progress');
    expect(x.db.accounts.get('rollover')?.exhausted_until ?? null).toBeNull();
    const note = 'ov-1 resumed after its login token rolled over on claude account Rollover Claude.';
    expect(x.notes).toContain(note);
    expect(isQuietNotice(note)).toBe(true);
    expect(x.wakes).not.toContain(note);
  });

  it('auth: skips a worker resume when the account reaches the usage gate without parking it', async () => {
    const usageGate = vi.fn<typeof accountUsable>()
      .mockResolvedValueOnce({ usable: true })
      .mockResolvedValueOnce({ usable: false, reason: 'account Resume Claude: session 83% >= 83% (85% - 1 running x 2%)' });
    const x = setup(undefined, 3, { usageGate });
    const first = Date.now() + 3 * 60 * 60_000;
    x.db.accounts.insert({ id: 'resume-gated', name: 'Resume Claude', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'r', token_expires_at: first, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'resume-gated');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    x.db.accounts.update('resume-gated', { secret: 'fresh-access', token_expires_at: first + 60_000 });

    emitAuthTurn(x, sid, 'native-resume-gated');

    await until(async () => (await x.status()) === 'open', WAIT, 'worker reopened after usage-gated auth resume');
    expect(x.db.sessions.forBead('ov-1').filter((session) => session.role === 'worker')).toHaveLength(1);
    expect(usageGate.mock.calls.map((call) => [call[2], call[3], call[6]])).toEqual([['resume-gated', 'sonnet', undefined], ['resume-gated', 'sonnet', sid]]);
    expect(x.db.accounts.get('resume-gated')?.exhausted_until ?? null).toBeNull();
    expect(x.notes.at(-1)).toContain('auth resume skipped: account Resume Claude: session 83% >= 83% (85% - 1 running x 2%)');
  });

  it('auth: a session whose token is unchanged and hours from expiry forces one refresh and resumes on the new token, not parked', async () => {
    const x = setup();
    const server = await tokenServer(200, JSON.stringify({ access_token: 'forced-access', refresh_token: 'rotated', expires_in: 36000 }));
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = server.url;
    try {
      // Three hours left is outside the refresh margin: without forcing, the resume would get the rejected token back.
      const expiry = Date.now() + 3 * 60 * 60_000;
      x.db.accounts.insert({ id: 'unchanged', name: 'Unchanged Claude', harness: 'claude', kind: 'oauth_token', secret: 'rejected-access', refresh_token: 'r', token_expires_at: expiry, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      claudeStandardAccount(x, 'unchanged');
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      expect(x.db.sessions.get(sid)?.token_expires_at).toBe(expiry);
      expect(server.requests).toHaveLength(0); // the spawn itself did not refresh
      emitAuthTurn(x, sid, 'native-same');
      await until(() => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'resumed worker');
      const resumed = x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)!;
      expect(resumed).toMatchObject({ native_session_id: 'native-same', status: 'running', auth_resumed: 1 });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r' });
      expect(x.fake.sessions.get(x.sessions.handleOf(resumed.id)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'forced-access' });
      expect(x.db.accounts.get('unchanged')?.exhausted_until ?? null).toBeNull();
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await server.close();
    }
  });

  it('auth: a forced refresh of an unchanged token that is rejected parks the account, as today', async () => {
    const x = setup();
    const server = await tokenServer(401, '{"error":"invalid_grant"}');
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = server.url;
    try {
      x.db.accounts.insert({ id: 'forced-dead', name: 'Forced Dead', harness: 'claude', kind: 'oauth_token', secret: 'rejected-access', refresh_token: 'revoked', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      claudeStandardAccount(x, 'forced-dead');
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      emitAuthTurn(x, sid, 'native-forced-dead');
      await until(() => x.db.accounts.get('forced-dead')?.exhausted_until === AUTH_HOLD_UNTIL, WAIT, 'parked');
      expect(server.requests).toHaveLength(1);
      expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker')).toHaveLength(1); // not resumed
      expect(x.notes.filter((n) => n.includes('could not authenticate'))).toHaveLength(1);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await server.close();
    }
  });

  it('auth: a first turn rejected with only an auth_failed event resumes by the native id chosen at spawn', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'first', name: 'First Claude', harness: 'claude', kind: 'oauth_token', secret: 'stale', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'first');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)?.native_session_id).toBe('spawn-native');
    x.db.accounts.update('first', { secret: 'fresh', token_expires_at: Date.now() + 4 * 60 * 60_000 }); // rolled over
    const h = x.sessions.handleOf(sid)!;
    x.fake.emit(h, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401', error: 'authentication_failed' });
    await x.fake.end(h); // the CLI exits without a turn_end
    await until(() => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'resumed worker');
    const resumed = x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)!;
    expect(x.fake.sessions.get(x.sessions.handleOf(resumed.id)!.id)!.opts.resumeId).toBe('spawn-native');
    expect(x.db.accounts.get('first')?.exhausted_until ?? null).toBeNull();
  });

  it('auth: an auth_failed recorded before a restart resumes the adopted session that exits without a turn_end', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'adopted', name: 'Adopted Claude', harness: 'claude', kind: 'oauth_token', secret: 'a', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'adopted');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    const native = x.db.sessions.get(sid)!.native_session_id!;
    expect(native).toBeTruthy();
    // The structured signal was consumed and recorded, but the process has not ended when the daemon restarts.
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401', error: 'authentication_failed' });
    await until(() => x.db.events.forSession(sid).some((e) => e.type === 'auth_failed'), WAIT, 'auth event recorded');
    x.db.accounts.update('adopted', { token_expires_at: Date.now() + 4 * 60 * 60_000 }); // rolled over: the resume needs no refresh
    // A restart: a new bus, session manager and lifecycle, with no memory of the signal, adopt the still-running process.
    const bus = new Bus();
    const sessions = new SessionManager(x.db, { claude: x.fake, codex: x.codex, opencode: x.opencode }, bus, path.join(path.dirname(x.worktreesDir), 'sessions'));
    const notes: string[] = [];
    new Lifecycle({ db: x.db, store: x.store, sessions, bus, config: x.config, provider: () => new LocalMergeProvider(), refreshRetryMs: 0, notify: async (m) => { notes.push(m); } });
    sessions.adopt({ ...x.db.sessions.get(sid)!, pid: 4242, pid_started_at: 'fake' });
    await x.fake.end(sessions.handleOf(sid)!); // the CLI exits without a turn_end, so only the record carries the signal
    await until(() => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'adopted session resumed');
    const resumed = x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)!;
    expect(resumed).toMatchObject({ native_session_id: native, status: 'running' });
    expect(x.db.accounts.get('adopted')?.exhausted_until ?? null).toBeNull();
    expect(notes).toContain('ov-1 resumed after its login token rolled over on claude account Adopted Claude.');
  });

  it('auth: a worker resumed once for auth is parked on its next 401 after a daemon restart adopts it', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'restart', name: 'Restart Claude', harness: 'claude', kind: 'oauth_token', secret: 'a', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'restart');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    x.db.accounts.update('restart', { token_expires_at: Date.now() + 4 * 60 * 60_000 }); // rolled over: the resume needs no refresh
    emitAuthTurn(x, sid, 'native-restart');
    await until(() => x.db.sessions.forBead('ov-1').length === 2, WAIT, 'resumed worker');
    const resumed = x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)!;
    expect(resumed.auth_resumed).toBe(1);
    // A restart: a new bus, session manager and lifecycle, with no memory of the resume, adopt the still-running process.
    const bus = new Bus();
    const sessions = new SessionManager(x.db, { claude: x.fake, codex: x.codex, opencode: x.opencode }, bus, path.join(path.dirname(x.worktreesDir), 'sessions'));
    const notes: string[] = [];
    new Lifecycle({ db: x.db, store: x.store, sessions, bus, config: x.config, provider: () => new LocalMergeProvider(), refreshRetryMs: 0, notify: async (m) => { notes.push(m); } });
    sessions.adopt({ ...x.db.sessions.get(resumed.id)!, pid: 4242, pid_started_at: 'fake' });
    const h = sessions.handleOf(resumed.id)!;
    x.fake.emit(h, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401', error: 'authentication_failed' });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-restart', cost: 0, authFailed: true });
    await until(() => x.db.accounts.get('restart')?.exhausted_until === AUTH_HOLD_UNTIL, WAIT, 'parked after the restart');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(2); // no second resume
    expect(notes.filter((n) => n.includes('could not authenticate'))).toHaveLength(1);
  });

  it('auth: a stop after the auth failure wins: the worker is settled as stopped and not resumed', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'stopped', name: 'Stopped Claude', harness: 'claude', kind: 'oauth_token', secret: 'a', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'stopped');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    x.db.accounts.update('stopped', { token_expires_at: Date.now() + 4 * 60 * 60_000 }); // a resume would have been possible
    const h = x.sessions.handleOf(sid)!;
    x.fake.emit(h, { type: 'auth_failed', text: 'Failed to authenticate. API Error: 401', error: 'authentication_failed' });
    await x.lc.interruptBead('ov-1');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'native-stopped', cost: 0, authFailed: true });
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened as stopped');
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(1); // no new session
    expect(x.notes).toContain('ov-1 stopped by the user from the Board; reopened without new commits.');
    expect(x.notes.some((n) => n.includes('resumed after its login token rolled over'))).toBe(false);
    expect(x.db.accounts.get('stopped')?.exhausted_until ?? null).toBeNull();
  });

  it('auth: a rejected refresh parks the account with one re-login notice, and the next dispatch skips it', async () => {
    const x = setup(undefined, 3, { usageGate: parkedGate });
    const server = await tokenServer(401, '{"error":"invalid_grant"}');
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = server.url;
    try {
      x.db.accounts.insert({ id: 'dead', name: 'Dead Claude', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'live-refresh', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      x.db.accounts.insert({ id: 'spare', name: 'Spare Claude', harness: 'claude', kind: 'oauth_token', secret: 'spare-access', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'dead' }, { harness: 'claude', model: 'sonnet', effort: null, account: 'spare' }];
      x.db.settings.set('tiers', tiers);
      const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      expect(x.db.sessions.get(first)).toMatchObject({ account: 'dead' });
      // The token lapses and its refresh is revoked only after the session started, so the start itself was not refused.
      x.db.accounts.update('dead', { token_expires_at: Date.now() - 1, refresh_token: 'revoked-refresh' });
      emitAuthTurn(x, first, 'native-park');
      await until(() => x.db.accounts.get('dead')?.exhausted_until === AUTH_HOLD_UNTIL && x.db.sessions.get(first)?.crash_class === 'auth', WAIT, 'account parked and auth crash recorded');
      expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker')).toHaveLength(1); // not resumed
      expect(x.notes.filter((n) => n.includes('could not authenticate'))).toHaveLength(1);
      expect(server.requests.some((r) => r.refresh_token === 'revoked-refresh')).toBe(true);
      x.store.add(x.repo.path, { id: 'ov-2', title: 'Next' });
      const second = await x.lc.spawnWorker('r1', 'ov-2', { tier: 'standard' });
      expect(x.db.sessions.get(second)?.account).toBe('spare');
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await server.close();
    }
  });

  it('auth: a resumed session rejected again parks the account and reopens the bead like an auth crash', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'twice', name: 'Twice Claude', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'twice');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    x.db.accounts.update('twice', { token_expires_at: Date.now() + 4 * 60 * 60_000 }); // rolled over, so the resume needs no refresh
    emitAuthTurn(x, sid, 'native-twice');
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker' && s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'resumed worker');
    const resumed = x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)!;
    emitAuthTurn(x, resumed.id, 'native-twice');
    await until(() => x.db.accounts.get('twice')?.exhausted_until === AUTH_HOLD_UNTIL && x.db.sessions.get(resumed.id)?.crash_class === 'auth', WAIT, 'parked after the second rejection');
    await until(async () => (await x.status()) === 'open', WAIT, 'bead reopened');
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker')).toHaveLength(2); // one resume only
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(true);
  });

  it('auth: two workers on one account ending together both resume, with one refresh', async () => {
    const x = setup();
    const server = await tokenServer(200, JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 7200 }));
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = server.url;
    try {
      x.db.accounts.insert({ id: 'shared', name: 'Shared Claude', harness: 'claude', kind: 'oauth_token', secret: 'old-access', refresh_token: 'shared-refresh', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      claudeStandardAccount(x, 'shared');
      x.store.add(x.repo.path, { id: 'ov-2', title: 'Other', description: 'Write other.txt' });
      const one = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      const two = await x.lc.spawnWorker('r1', 'ov-2', { tier: 'standard' });
      // The token lapses after both started: their recoveries must share one refresh.
      x.db.accounts.update('shared', { token_expires_at: Date.now() - 1 });
      emitAuthTurn(x, one, 'native-one');
      emitAuthTurn(x, two, 'native-two');
      await until(() => x.db.sessions.forBead('ov-1').length === 2 && x.db.sessions.forBead('ov-2').length === 2, WAIT, 'both resumed');
      expect(server.requests).toHaveLength(1);
      expect(x.db.accounts.get('shared')?.exhausted_until ?? null).toBeNull();
      expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker').at(-1)).toMatchObject({ native_session_id: 'native-one' });
      expect(x.db.sessions.forBead('ov-2').filter((s) => s.role === 'worker').at(-1)).toMatchObject({ native_session_id: 'native-two' });
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await server.close();
    }
  });

  it('auth: a clean end whose final text quotes a 401 is not an auth failure and parks nothing', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'healthy', name: 'Healthy Claude', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeStandardAccount(x, 'healthy');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'I probed it: Failed to authenticate. API Error: 401 OAuth access token has expired.' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(async () => (await x.phase()) === 'review', WAIT, 'verified and in review');
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker')).toHaveLength(1);
    expect(x.db.accounts.get('healthy')?.exhausted_until ?? null).toBeNull();
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(false);
    expect(x.notes.some((n) => n.includes('resumed after its login token rolled over'))).toBe(false);
  });

  it('auth: an opencode worker whose final text quotes a 401 parks nothing', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'oc-key', name: 'Deepseek personal api key', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'sk-deepseek', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'opencode', model: 'deepseek/deepseek-flash', effort: null, account: 'oc-key' }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'opencode', account: 'oc-key' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.opencode.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' });
    x.opencode.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0 });
    await until(async () => (await x.phase()) === 'review', WAIT, 'verified and in review');
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker')).toHaveLength(1);
    expect(x.db.accounts.get('oc-key')?.exhausted_until ?? null).toBeNull();
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(false);
  });

  it('auth: does not repeat the re-login notice for an account that is already parked', async () => {
    const x = setup();
    x.db.accounts.insert({ id: 'parked', name: 'Work', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null, exhausted_until: AUTH_HOLD_UNTIL });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    x.db.sessions.update(sid, { account: 'parked' });
    emitAuthTurn(x, sid, 'native-parked');
    await until(() => x.db.sessions.get(sid)?.crash_class === 'auth', WAIT, 'auth crash recorded');
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(false);
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'worker')).toHaveLength(1); // no resume on a parked account
  });

  it('auth: a non-authentication failure does not park the account', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    x.db.accounts.insert({ id: 'a1', name: 'Work', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.sessions.update(sid, { account: 'a1' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'error', message: 'claude exited with code 1' });
    await x.fake.end(x.sessions.handleOf(sid)!);
    await until(() => x.db.sessions.get(sid)?.crash_class === 'task', WAIT, 'task crash recorded');
    expect(x.db.accounts.get('a1')?.exhausted_until ?? null).toBeNull();
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(false);
  });

  it('auth: a 401 on the CLI\'s own login records an auth crash without parking an account', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    expect(x.db.sessions.get(sid)?.account).toBeNull();
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'error', message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.' });
    await x.fake.end(x.sessions.handleOf(sid)!);
    await until(() => x.db.sessions.get(sid)?.crash_class === 'auth', WAIT, 'auth crash recorded');
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(false);
  });
});

describe.concurrent('Lifecycle review rounds', () => {
  const critic = (x: ReturnType<typeof setup>, id = 'ov-1') => x.db.sessions.forBead(id).find((s) => s.role === 'critic' && s.status === 'running');
  const workers = (x: ReturnType<typeof setup>, id = 'ov-1') => x.db.sessions.forBead(id).filter((s) => s.role === 'worker');
  const validEvidence = async (x: ReturnType<typeof setup>) => {
    const wt = x.db.worktrees.get('ov-1')!;
    const head = await shAsync(wt.path, ['rev-parse', 'HEAD']);
    return `Parity: Frame 1 | 390 | en | 0 | ${head}\nEvidence: https://example.invalid/capture.png - final capture`;
  };
  /** A worker on codex (standard tier) that commits and ends; resolves once the critic is live. */
  async function workerDone(x: ReturnType<typeof setup>, batchId?: string, tier: 'standard' | 'hard' = 'standard', verifyCommand?: string) {
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier, batchId, ...(verifyCommand ? { verifyOnly: true, verifyCommand } : {}) });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Added hello.txt' });
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'critic session');
    return { sid, wt, critic: critic(x)! };
  }
  const endCritic = (x: ReturnType<typeof setup>, id: string) => x.fake.emit(x.sessions.handleOf(id)!, { type: 'turn_end', nativeSessionId: 'c1', cost: 0.2 });
  /** A worker on the given tier that commits and ends; resolves once the bead's critic is live. */
  async function workerDoneAt(x: ReturnType<typeof setup>, id: string, tier: 'chore' | 'standard' | 'hard', file: string, content = 'hi\n') {
    const sid = await x.lc.spawnWorker('r1', id, { tier });
    const wt = x.db.worktrees.get(id)!;
    await commitFileAsync(wt.path, file, content, `add ${file}`);
    const adapter = x.db.sessions.get(sid)!.harness === 'claude' ? x.fake : x.codex;
    adapter.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: `Added ${file}` });
    adapter.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x, id), WAIT, `${id} critic`);
    return critic(x, id)!;
  }

  it('a chore bead is reviewed by the cheaper chore critic tier, a hard bead by the critic tier', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const tiers = structuredClone(x.db.settings.tiers());
    tiers.tiers.push({ name: 'critic-chore', candidates: [{ harness: 'claude', model: 'haiku', effort: null }] });
    x.db.settings.set('tiers', tiers);

    const chore = await workerDoneAt(x, 'ov-1', 'chore', 'hello.txt');
    expect(chore).toMatchObject({ harness: 'claude', model: 'haiku', tier: 'critic-chore' });

    x.store.add(x.repo.path, { id: 'ov-2', title: 'Add farewell', description: 'Write bye.txt' });
    const standard = await workerDoneAt(x, 'ov-2', 'hard', 'bye.txt');
    expect(standard).toMatchObject({ harness: 'claude', model: 'fable', tier: 'critic' });
  });

  // 2026-09-28: four chore critics ran on an account-less opencode candidate while the opencode login held no DeepSeek key;
  // each exited 1 two seconds in with a bare UnknownError and the round was lost.
  describe('an account-less opencode chore critic', () => {
    const withOpencodeFirst = (x: ReturnType<typeof setup>, account?: string) => {
      const tiers = structuredClone(x.db.settings.tiers());
      tiers.tiers.push({ name: 'critic-chore', candidates: [{ harness: 'opencode', model: 'deepseek/deepseek-flash', effort: 'medium', ...(account ? { account } : {}) }, { harness: 'claude', model: 'haiku', effort: null }] });
      x.db.settings.set('tiers', tiers);
    };

    it('is skipped for the next candidate when the opencode login holds no key for its provider', async () => {
      const asked: string[] = [];
      const x = setup(undefined, 3, { reviewRounds: 1, opencodeLoginReaches: (model) => { asked.push(model); return false; } });
      withOpencodeFirst(x);
      const c = await workerDoneAt(x, 'ov-1', 'chore', 'hello.txt');
      expect(c).toMatchObject({ harness: 'claude', model: 'haiku', tier: 'critic-chore' });
      expect(x.opencode.sessions.size).toBe(0);
      expect(asked).toContain('deepseek/deepseek-flash');
    });

    it('runs when the opencode login holds a key for its provider', async () => {
      const x = setup(undefined, 3, { reviewRounds: 1, opencodeLoginReaches: () => true });
      withOpencodeFirst(x);
      const c = await workerDoneAt(x, 'ov-1', 'chore', 'hello.txt');
      expect(c).toMatchObject({ harness: 'opencode', model: 'deepseek/deepseek-flash', account: null, tier: 'critic-chore' });
    });

    it('does not apply to an opencode candidate with an account, which carries its own key', async () => {
      const asked: string[] = [];
      const x = setup(undefined, 3, { reviewRounds: 1, opencodeLoginReaches: (model) => { asked.push(model); return false; } });
      x.db.accounts.insert({ id: 'oc1', name: 'oc1', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'key-oc1', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      withOpencodeFirst(x, 'oc1');
      const c = await workerDoneAt(x, 'ov-1', 'chore', 'hello.txt');
      expect(c).toMatchObject({ harness: 'opencode', model: 'deepseek/deepseek-flash', account: 'oc1', tier: 'critic-chore' });
      expect(asked).toEqual([]);
    });
  });

  const withCriticChore = (x: ReturnType<typeof setup>) => {
    const tiers = structuredClone(x.db.settings.tiers());
    tiers.tiers.push({ name: 'critic-chore', candidates: [{ harness: 'claude', model: 'haiku', effort: null }, { harness: 'claude', model: 'fable', effort: null }] });
    x.db.settings.set('tiers', tiers);
  };
  const mustFindings = [{ file: 'hello.txt', summary: 'Broken.', severity: 'must' as const }];

  it('a chore bead gets one round on the chore critic tier: a must there parks it, whatever the cap', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    withCriticChore(x);
    const c = await workerDoneAt(x, 'ov-1', 'chore', 'hello.txt');
    expect(c).toMatchObject({ model: 'haiku', tier: 'critic-chore' });
    expect(criticPrompt(x, c.id)).toContain('review round 1 of 1');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, c.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked');
    expect(workers(x)).toHaveLength(1);
    expect(x.wakes.at(-1)).toMatch(/^ov-1 awaits a decision: review round 1 of 1 /);
  });

  it('a standard bead with a small diff: round 1 on the chore critic tier, and a must there earns round 2 on critic with another model', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    withCriticChore(x);
    const { critic: c1 } = await workerDone(x);
    expect(c1).toMatchObject({ model: 'haiku', tier: 'critic-chore' });
    expect(criticPrompt(x, c1.id)).toContain('review round 1 of 1');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Review diff: 1 changed lines against `main...HEAD`');
    expect(x.db.worktrees.get('ov-1')?.review_diff_lines).toBe(1);
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    expect(x.notes.at(-1)).toMatch(/^ov-1 review round 1 of 2 /);
    expect(x.db.worktrees.get('ov-1')?.review_diff_lines).toBe(1); // the re-dispatch keeps the first measurement
    x.codex.emit(x.sessions.handleOf(workers(x)[1]!.id)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'second critic');
    const c2 = critic(x)!;
    expect(c2).toMatchObject({ model: 'fable', tier: 'critic' });
    expect(criticPrompt(x, c2.id)).toContain('review round 2 of 2');
    expect((await x.store.show(x.repo.path, 'ov-1'))!.notes!.split('Review diff:').length - 1).toBe(1); // measured once per review cycle
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, c2.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked at 2 despite a cap of 3');
    expect(workers(x)).toHaveLength(2);
  });

  it('round 2 prefers a model other than round 1\'s on the critic tier', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    x.db.settings.set('tiers', { tiers: [{ name: 'hard', candidates: [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }] }, { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }, { harness: 'claude', model: 'opus', effort: null }] }], denyModels: [] });
    const c1 = await workerDoneAt(x, 'ov-1', 'hard', 'hello.txt');
    expect(c1).toMatchObject({ model: 'fable', tier: 'critic' });
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    x.codex.emit(x.sessions.handleOf(workers(x)[1]!.id)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'second critic');
    expect(critic(x)).toMatchObject({ model: 'opus', tier: 'critic' });
  });

  it('a standard bead whose diff is over 400 lines gets a second critic round after a clean first one, then lands', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'big.txt', 'x\n'.repeat(401), 'add big.txt');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'first critic');
    const c1 = critic(x)!;
    expect(criticPrompt(x, c1.id)).toContain('review round 1 of 2');
    expect(x.db.worktrees.get('ov-1')?.review_diff_lines).toBe(401);
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c1.id);
    await until(() => !!critic(x) && critic(x)!.id !== c1.id, WAIT, 'second critic');
    const c2 = critic(x)!;
    expect(c2.tier).toBe('critic');
    expect(criticPrompt(x, c2.id)).toContain('review round 2 of 2');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 2, merged_at: null });
    expect(workers(x)).toHaveLength(1); // no worker re-dispatch: nothing was a must
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c2.id);
    await until(() => x.notes.some((n) => n.startsWith('ov-1 landed')), WAIT, 'landed after round 2');
    expect(await x.status()).toBe('closed');
  });

  it('keeps round 1 should findings when a large standard bead lands after a clean round 2', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'big.txt', 'x\n'.repeat(401), 'add big.txt');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'first critic');
    const c1 = critic(x)!;
    const findings = [{ file: 'big.txt', summary: 'Document the generated lines.', severity: 'should' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, c1.id);
    await until(() => !!critic(x) && critic(x)!.id !== c1.id, WAIT, 'second critic');
    const c2 = critic(x)!;
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c2.id);
    await until(() => x.notes.some((n) => n.startsWith('ov-1 landed')), WAIT, 'landed after round 2');
    const heading = `Review findings landed with (round 1):\n${renderFindings(findings)}`;
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain(heading);
    expect(x.notes.at(-1)).toContain(heading.charAt(0).toLowerCase() + heading.slice(1));
    expect(occurrences((await x.store.show(x.repo.path, 'ov-1'))!.notes ?? '', heading)).toBe(1);
    expect(occurrences(x.notes.at(-1) ?? '', renderFindings(findings))).toBe(1);
  });

  const largeShouldRound1 = async (x: ReturnType<typeof setup>) => {
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'big.txt', 'x\n'.repeat(401), 'add big.txt');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'first critic');
    const findings = [{ file: 'big.txt', summary: 'Document the generated lines.', severity: 'should' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    return { c1: critic(x)!, findings };
  };

  it('a round 2 that cannot start after a should-only round 1 leaves the bead ready, not awaiting a decision', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    const { c1 } = await largeShouldRound1(x);
    x.db.settings.set('tiers', { tiers: [], denyModels: [] }); // no critic candidate for round 2
    endCritic(x, c1.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_findings: null, merged_at: null });
    const card = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(card.state).not.toBe('awaiting_decision');
  });

  it('a round 2 must parks with its own findings, and accepting it lands round 1\'s should findings too', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    const { c1, findings } = await largeShouldRound1(x);
    endCritic(x, c1.id);
    await until(() => !!critic(x) && critic(x)!.id !== c1.id, WAIT, 'second critic');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, critic(x)!.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked');
    expect(x.db.worktrees.get('ov-1')?.review_findings).toEqual(mustFindings);
    await x.lc.acceptReview('r1', 'ov-1', 'Fine as it is.');
    await until(() => x.notes.some((n) => n.startsWith('ov-1 landed')), WAIT, 'landed');
    const heading = `Review findings landed with (round 1):\n${renderFindings(findings)}`;
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain(heading);
    expect(x.notes.at(-1)).toContain(heading.charAt(0).toLowerCase() + heading.slice(1));
  });

  it('a standard bead whose diff is exactly 400 lines is planned for one round', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'big.txt', 'x\n'.repeat(400), 'add big.txt');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'first critic');
    const c = critic(x)!;
    expect(criticPrompt(x, c.id)).toContain('review round 1 of 1');
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c.id);
    await until(async () => (await x.status()) === 'closed', WAIT, 'landed after round 1');
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'critic')).toHaveLength(1);
  });

  it('a hard bead gets the repo cap in rounds, all on critic', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    withCriticChore(x);
    const c = await workerDoneAt(x, 'ov-1', 'hard', 'hello.txt');
    expect(c).toMatchObject({ tier: 'critic' });
    expect(criticPrompt(x, c.id)).toContain('review round 1 of 3');
  });

  it('a chore bead reviews on the critic tier when the cheaper chore critic tier is not configured', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    expect(x.db.settings.tiers().tiers.some((t) => t.name === 'critic-chore')).toBe(false);
    const c = await workerDoneAt(x, 'ov-1', 'chore', 'hello.txt');
    expect(c).toMatchObject({ harness: 'claude', model: 'fable', tier: 'critic' });
  });

  const criticPrompt = (x: ReturnType<typeof setup>, id: string) => x.fake.sessions.get(x.sessions.handleOf(id)!.id)!.opts.prompt;

  it('diffs a bead that merged no base against its base branch, as before', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const { critic: c } = await workerDone(x);
    const prompt = criticPrompt(x, c.id);
    expect(prompt).toContain('diff against `main...HEAD`');
    expect(prompt).toContain('+hi');
  });

  it('reviews a bead whose branch merged its base in on the resolution, not the base movement', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    expect(wt.base_branch).toBe('feature/reviewed');
    // The base branch moved on after the batch branched: merging it into the bead's own work is what makes `base...HEAD` carry
    // that movement as well as the change under review.
    await commitFileAsync(wt.path, 'seed.txt', 'seed\n', 'start the work');
    await commitFileAsync(x.repo.path, 'moved.txt', 'BASE-MOVEMENT\n', 'base moves on');
    await shAsync(wt.path, ['merge', 'main', '--no-edit', '-m', 'merge main']);
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'critic after a merge-from-base bead');
    const prompt = criticPrompt(x, critic(x)!.id);
    expect(prompt).toContain('+hi'); // the work after the merge
    expect(prompt).toContain('+seed'); // and the work the merge carried forward
    expect(prompt).not.toContain('BASE-MOVEMENT');
    expect(prompt).not.toContain('diff against `feature/reviewed...HEAD`');
  });

  it('reports an oversized prompt with its size, limit and refs instead of crashing the round', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'huge.txt', 'a line of a very large generated file\n'.repeat(32000), 'add a large file');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'critic on an oversized change');
    const prompt = criticPrompt(x, critic(x)!.id);
    expect(prompt.length).toBeLessThanOrEqual(1_048_576);
    expect(prompt).toContain('The diff itself is not included');
    expect(prompt).toMatch(/accepts 1048576/);
    expect(prompt).toContain('huge.txt');
    expect(prompt).toContain('submit_review'); // the verdict instructions survive every reduction
    await until(async () => (await x.store.show(x.repo.path, 'ov-1'))!.notes.includes('the 1048576 characters claude accepts'), WAIT, 'oversized-prompt note');
    const note = (await x.store.show(x.repo.path, 'ov-1'))!.notes;
    expect(note).toContain('main...HEAD'); // the refs it diffed
    expect(note).toMatch(/which made the prompt \d{7} characters/); // and the measured size
    expect(x.notes.some((n) => n.includes("its review round prompt did not fit the critic's harness") && n.includes('main...HEAD'))).toBe(true);
    expect(await x.status()).toBe('in_progress'); // the round runs; the bead does not reopen as a critic failure
  });

  vitestIt.each([null, 'claude-work'])('forced harness review retries keep claude, its model and account (%s) across rounds', async (account) => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    if (account) x.db.accounts.insert({ id: account, name: 'Work Claude', harness: 'claude', kind: 'api_key', secret: 'test-key', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: 'opus', batchId: 'r1-b1' });
    // Exercise the persisted selection, including a named account, without relying on a new public routing option.
    x.db.sessions.update(sid, { account });
    expect(x.db.sessions.get(sid)).toMatchObject({ tier: null, harness: 'claude', model: 'opus', account });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    const findings = [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' as const }];

    await until(() => !!critic(x), WAIT, 'critic round 1');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2 && x.notes.length === 1, WAIT, 'retry round 1');
    const retry = workers(x).at(-1)!;
    expect(retry).toMatchObject({ tier: null, harness: 'claude', model: 'opus', account, status: 'running', batch_id: 'r1-b1' });
    const start = x.fake.sessions.get(x.sessions.handleOf(retry.id)!.id)!.opts;
    expect(start.model).toBe('opus');
    expect(start.env).toEqual(account ? { ANTHROPIC_API_KEY: 'test-key', CLAUDE_CODE_OAUTH_TOKEN: undefined } : {});
    expect(start.resumeId).toBe('n1');
    expect(start.prompt).toContain(renderFindings(findings));
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1);
    expect(x.wakes).toEqual([]);
    // A forced dispatch counts as standard: round 2 is its last, even under a cap of 3.
    x.finishTurn(retry.id);
    await until(() => !!critic(x), WAIT, 'critic round 2');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => x.wakes.length === 1, WAIT, 'parked after round 2');
    expect(x.wakes[0]).toMatch(/^ov-1 awaits a decision: review round 2 of 2 /);
    expect(workers(x)).toHaveLength(2);
  });

  it('forced harness review retries replace an account whose Claude authorization can no longer be refreshed', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    const requests: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
        res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"invalid_grant"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    try {
      // Both accounts are real Claude OAuth accounts. The recorded one starts with a token more than the two-hour refresh
      // window out, so the first spawn leaves it alone; it then expires with its refresh token revoked, and a stored secret
      // keeps `accountLoggedIn` true, so only a real refresh attempt can tell it is dead.
      x.db.accounts.insert({ id: 'prior', name: 'Prior Claude', harness: 'claude', kind: 'oauth_token', secret: 'prior-stale-access', refresh_token: 'prior-live-refresh', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      x.db.accounts.insert({ id: 'fallback', name: 'Fallback Claude', harness: 'claude', kind: 'oauth_token', secret: 'fallback-access', refresh_token: null, token_expires_at: null, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      const tiers = structuredClone(x.db.settings.tiers());
      for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'fallback' }];
      x.db.settings.set('tiers', tiers);
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: 'opus', account: 'prior' });
      expect(x.db.sessions.get(sid)).toMatchObject({ tier: null, harness: 'claude', model: 'opus', account: 'prior' });
      await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
      x.finishTurn(sid);
      await until(() => !!critic(x), WAIT, 'critic after forced worker');
      x.db.accounts.update('prior', { token_expires_at: Date.now() - 1, refresh_token: 'revoked-refresh' });
      x.lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' }] });
      endCritic(x, critic(x)!.id);
      await until(() => workers(x).length === 2, WAIT, 'retry after the authorization was revoked');
      const retry = workers(x).at(-1)!;
      expect(retry).toMatchObject({ tier: null, harness: 'claude', model: 'opus', account: 'fallback', status: 'running' });
      expect(x.fake.sessions.get(x.sessions.handleOf(retry.id)!.id)!.opts.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'fallback-access' });
      // The failing refresh was really attempted, and no access token reached a notice the daemon posts.
      expect(requests.some((request) => request.refresh_token === 'revoked-refresh')).toBe(true);
      expect(x.notes.some((note) => note.includes('prior-stale-access') || note.includes('fallback-access'))).toBe(false);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });


  it('forced harness review retries yield to resolveTier after an explicit tier selection', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', model: 'opus' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    const findings = [{ file: null, summary: 'Cover the greeting.', severity: 'must' as const }];
    await until(() => !!critic(x), WAIT, 'forced critic');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2 && x.notes.length === 1, WAIT, 'forced retry');
    const forced = workers(x).at(-1)!;
    expect(forced).toMatchObject({ tier: null, harness: 'claude', model: 'opus' });

    // Park the forced attempt, then explicitly select a tier even though a harness is also supplied.
    x.db.repos.update('r1', { review_rounds: 1 });
    x.finishTurn(forced.id);
    await until(() => !!critic(x), WAIT, 'last forced critic');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => x.wakes.length === 1, WAIT, 'parked forced attempt');
    x.db.repos.update('r1', { review_rounds: 3 });
    const tiered = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(tiered)).toMatchObject({ tier: 'standard', harness: 'codex', model: 'gpt-5.6-terra' });

    x.codex.emit(x.sessions.handleOf(workers(x).at(-1)!.id)!, { type: 'turn_end', nativeSessionId: 'tier-session', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'tier critic');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 4 && x.notes.length === 3, WAIT, 'tier retry');
    const retry = workers(x).at(-1)!;
    expect(retry).toMatchObject({ tier: 'standard', harness: 'codex', model: 'gpt-5.6-terra' });
    expect(x.codex.sessions.get(x.sessions.handleOf(retry.id)!.id)!.opts.resumeId).toBe('tier-session');
  });

  /** The hard tier with codex first and a claude entry at high effort: a retry that dropped the forced harness would land on codex. */
  const hardWithClaude = (x: ReturnType<typeof setup>) => {
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'hard') tier.candidates = [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }, { harness: 'claude', model: 'opus', effort: 'high' }];
    x.db.settings.set('tiers', tiers);
  };

  it('an automatic review retry of a harness forced with a tier stays on that harness and tier', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    hardWithClaude(x);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => !!critic(x), WAIT, 'critic after the forced worker');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' }] });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2, WAIT, 'automatic review retry');
    expect(workers(x).at(-1)).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard', harness_forced: 1, status: 'running' });
  });

  it('an automatic review retry of a harness forced with a tier is refused, not moved, when the tier has no usable candidate of it left', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    hardWithClaude(x);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => !!critic(x), WAIT, 'critic after the forced worker');
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'hard') tier.candidates = tier.candidates.filter((c) => c.harness !== 'claude');
    x.db.settings.set('tiers', tiers);
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' }] });
    endCritic(x, critic(x)!.id);
    await until(() => x.wakes.length === 1, WAIT, 'refused review retry');
    expect({ workers: workers(x).length, wake: x.wakes[0] }).toMatchObject({ workers: 1, wake: expect.stringContaining('the re-dispatch was refused: no usable claude candidate in tier hard') });
  });

  it('an automatic review retry after a daemon restart and re-adoption keeps the forced harness and the tier', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-forced-tier-adopt-'));
    const dbPath = path.join(tempDir, 'daemon.sqlite');
    const x = setup(undefined, 3, { reviewRounds: 2, dbPath });
    hardWithClaude(x);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', tier: 'hard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    const logFile = path.join(tempDir, 'worker.log');
    const child = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
    let restartedDb: ReturnType<typeof openDb> | null = null;
    let originalClosed = false;
    try {
      x.db.sessions.update(sid, { pid: child.pid!, pid_started_at: await processStartTime(child.pid!), log_path: logFile, log_offset: 0 });
      x.db.sql.close();
      originalClosed = true;
      // A restart: the rows are read back from the file, and a new session manager and lifecycle adopt the running worker.
      const db = openDb(dbPath, { batchIdSuffix: () => '' });
      restartedDb = db;
      const bus = new Bus();
      const sessions = new SessionManager(db, { claude: x.fake, codex: x.codex, opencode: x.opencode }, bus, path.join(tempDir, 'sessions'));
      const lc = new Lifecycle({ db, store: x.store, sessions, bus, config: x.config, doctorRunner: async () => ({ code: 0, stdout: 'claude 2.1.0', stderr: '' }), usageGate: async () => ({ usable: true }), reapEnded: async () => [], provider: () => new LocalMergeProvider(), refreshRetryMs: 0, notify: async (message) => { x.notes.push(message); } });
      await lc.recover();
      const y = { ...x, db, sessions, lc };
      x.fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'adopted-worker', cost: 0.1 });
      await until(() => !!critic(y), WAIT, 'critic after the adopted worker');
      lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' }] });
      endCritic(y, critic(y)!.id);
      await until(() => workers(y).length === 2, WAIT, 'automatic review retry after the restart');
      expect(workers(y).at(-1)).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard', harness_forced: 1, status: 'running' });
    } finally {
      await killProcess(child.pid!).catch(() => {});
      if (restartedDb) restartedDb.sql.close();
      else if (!originalClosed) x.db.sql.close();
    }
  });

  /** The standard tier with opencode first: a stalled opencode worker leaves claude sonnet as the only other candidate. */
  function opencodeFirst(x: ReturnType<typeof setup>, opencodeOnly = false) {
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = opencodeOnly
      ? [{ harness: 'opencode', model: 'deepseek/deepseek-flash', effort: null }]
      : [{ harness: 'opencode', model: 'deepseek/deepseek-flash', effort: null }, { harness: 'claude', model: 'sonnet', effort: null }];
    x.db.settings.set('tiers', tiers);
  }
  /** A worker whose opencode session committed, then went silent past the threshold and was stopped by the orchestrator; resolves with the critic that reviewed its branch. */
  async function stalledWorker(x: ReturnType<typeof setup>) {
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    // The sweep's own measure: no event for longer than the threshold, then the orchestrator's interrupt.
    x.db.sql.prepare('UPDATE events SET ts=? WHERE session_id=?').run(new Date(Date.now() - 20 * 60_000).toISOString(), sid);
    await x.lc.interruptBead('ov-1', { by: 'orchestrator', reason: 'no sign of activity for 20 minutes' });
    await until(() => !!critic(x), WAIT, 'critic after the stalled worker');
    return sid;
  }

  it('an automatic review retry avoids the harness whose worker stalled and picks the next candidate', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    opencodeFirst(x);
    const sid = await stalledWorker(x);
    expect(x.db.sessions.get(sid)).toMatchObject({ tier: 'standard', harness: 'opencode', model: 'deepseek/deepseek-flash' });
    expect(critic(x)).toMatchObject({ harness: 'claude' });

    const findings = [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2, WAIT, 'automatic retry');
    const retry = workers(x).at(-1)!;
    expect(retry).toMatchObject({ tier: 'standard', harness: 'claude', model: 'sonnet', status: 'running' });
    expect(x.notes.at(-1)).toContain('re-dispatched to claude sonnet');
    expect(x.opencode.sessions.size).toBe(1); // no second opencode session was started
  });

  it('refuses the automatic review retry, naming the stalled harness, when it is the only candidate', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    opencodeFirst(x, true);
    await stalledWorker(x);

    const findings = [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => x.notes.length === 2, WAIT, 'refused re-dispatch');
    expect(await x.status()).toBe('open');
    expect(await x.phase()).toBeNull();
    expect(workers(x)).toHaveLength(1);
    expect(x.notes.at(-1)).toContain('no usable harness for tier standard: opencode was stopped for inactivity');
  });

  it('an automatic review retry drops a forced harness whose worker stalled and goes through the standard tier without it', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    opencodeFirst(x);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'opencode', model: 'deepseek/deepseek-flash' });
    expect(x.db.sessions.get(sid)).toMatchObject({ tier: null, harness: 'opencode' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.db.sql.prepare('UPDATE events SET ts=? WHERE session_id=?').run(new Date(Date.now() - 20 * 60_000).toISOString(), sid);
    await x.lc.interruptBead('ov-1', { by: 'orchestrator', reason: 'no sign of activity for 20 minutes' });
    await until(() => !!critic(x), WAIT, 'critic after the stalled forced worker');

    const findings = [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2, WAIT, 'automatic retry');
    expect(workers(x).at(-1)).toMatchObject({ tier: 'standard', harness: 'claude', model: 'sonnet', status: 'running' });
    expect(x.opencode.sessions.size).toBe(1); // the forced opencode pin was not reused
  });

  it('an automatic review retry avoids a harness whose worker failed to start and picks the next candidate', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }, { harness: 'claude', model: 'sonnet', effort: null }];
    x.db.settings.set('tiers', tiers);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ tier: 'standard', harness: 'codex', model: 'gpt-5.6-terra' });
    // The reopen path labels a CLI that rejected its arguments a harness bug and records it on the session; an automatic retry must avoid it.
    x.db.sessions.update(sid, { crash_class: 'harness_bug' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Added hello.txt' });
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'critic after the harness-bug worker');

    const findings = [{ file: 'hello.txt', summary: 'Cover the greeting.', severity: 'must' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2, WAIT, 'automatic retry');
    const retry = workers(x).at(-1)!;
    expect(retry).toMatchObject({ tier: 'standard', harness: 'claude', model: 'sonnet', status: 'running' });
    expect(x.notes.at(-1)).toContain('re-dispatched to claude sonnet');
    expect(x.codex.sessions.size).toBe(1); // no second codex session was started
  });

  it('re-dispatches a rate-limited critic on the next usable account without advancing its round', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async (db, _config, accountId) => db.accounts.get(accountId)?.exhausted_until ? { usable: false, reason: `account ${accountId} exhausted` } : { usable: true });
    const x = setup(undefined, 3, { reviewRounds: 2, usageGate });
    for (const id of ['a1', 'a2']) x.db.accounts.insert({ id, name: `Claude ${id}`, harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'critic') tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account: 'a1' }, { harness: 'claude', model: 'fable', effort: null, account: 'a2' }];
    x.db.settings.set('tiers', tiers);
    const { critic: first } = await workerDone(x);
    x.fake.emit(x.sessions.handleOf(first.id)!, { type: 'rate_limit', kind: 'rate_limit', bucket: 'five_hour', resetsAt: '2026-09-17T10:00:00.000Z', raw: {} });
    await until(() => !!critic(x) && critic(x)!.id !== first.id, WAIT, 'critic rate-limit re-dispatch');
    expect(critic(x)).toMatchObject({ account: 'a2', tier: 'critic' });
    expect(critic(x)?.model).not.toBe(workers(x)[0]?.model);
    expect(x.fake.sent(x.sessions.handleOf(critic(x)!.id)!)[0]).toContain('Added hello.txt');
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1);
    expect(usageGate.mock.calls.some((call) => call[2] === 'a2' && call[3] === 'fable')).toBe(true);
  });

  it('usage limit: re-dispatches a critic that ended on one to the next critic candidate, without reopening or spending a round', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'critic') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }, { harness: 'claude', model: 'fable', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const { critic: first } = await workerDone(x, 'r1-b1');
    expect(first.harness).toBe('codex');
    // Only the re-dispatch's own writes are watched: the critic round must not touch Ready or emit a reopen signal on the way.
    const wrote: string[] = [];
    const update = x.store.update.bind(x.store);
    const spy = vi.spyOn(x.store, 'update').mockImplementation(async (p, id, patch) => { if (patch.status) wrote.push(patch.status); return update(p, id, patch); });
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first.id)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message: 'usage limit' });
    x.codex.emit(h, { type: 'error', message: 'exceeded retry limit' });
    await x.codex.end(h);
    await until(() => !!critic(x) && critic(x)!.id !== first.id, WAIT, 'critic usage-limit re-dispatch');
    spy.mockRestore();
    expect(critic(x)).toMatchObject({ harness: 'claude', model: 'fable', tier: 'critic' });
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1); // the lost round resumes; a new round is not spent on the exhausted harness
    expect(await x.status()).toBe('in_progress'); // the task is not reopened for the user
    expect(wrote).toEqual(['in_progress']); // the bead goes straight from Verifying to the new critic; it never flashes Ready
    expect(x.db.signals.forBatch('r1-b1').filter((s) => s.kind === 'reopen')).toEqual([]); // the retrospective must not report a reopen
    expect((x.db.settings.get('harness_limits') as Record<string, number>).codex).toBe(reset.getTime());
    expect(x.notes.at(-1)).toMatch(/^ov-1 re-dispatched: codex exhausted until .+, now on claude\.$/);
  });

  it('usage limit: a critic with no candidate left goes Ready with a reopen signal and keeps its round', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    // Only codex exists in any tier `startReview` can fall through to, so holding codex leaves the critic with no candidate.
    x.db.settings.set('tiers', { tiers: [
      { name: 'standard', candidates: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null, account: null }] },
      { name: 'critic', candidates: [{ harness: 'codex', model: 'terra', effort: null, account: null }] },
    ], denyModels: [] });
    const { critic: first } = await workerDone(x, 'r1-b1');
    expect(first.harness).toBe('codex');
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first.id)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message: 'usage limit' });
    x.codex.emit(h, { type: 'error', message: 'exceeded retry limit' });
    await x.codex.end(h);
    await until(() => x.db.signals.forBatch('r1-b1').some((s) => s.kind === 'reopen'), WAIT, 'critic reopen signal');
    await until(() => x.notes.some((n) => n.includes('no usable account left')), WAIT, 'critic waiting notice');
    expect(await x.status()).toBe('open'); // with no critic candidate the bead waits at Ready
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1); // the failed round is not counted
    expect(x.db.signals.forBatch('r1-b1').filter((s) => s.kind === 'reopen')).toHaveLength(1); // the retrospective records the reopen
    expect((x.db.settings.get('harness_limits') as Record<string, number>).codex).toBe(reset.getTime());
    expect(x.notes.at(-1)).toMatch(/^ov-1 re-dispatched: codex exhausted until .+, no usable account left; waiting\.$/);
  });

  it('a verify pass starts a critic of another model with the diff, and the bead does not land until it passes', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const { sid, wt, critic: c } = await workerDone(x, 'r1-b1');
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra' });
    expect(c).toMatchObject({ harness: 'claude', model: 'fable', tier: 'critic', cwd: wt.path });
    const prompt = x.fake.sent(x.sessions.handleOf(c.id)!)[0]!;
    expect(prompt).toContain('Task ov-1: Add greeting');
    expect(prompt).toContain('+hi');
    expect(prompt).toContain('Added hello.txt');
    expect(prompt).toContain('review round 1 of 1'); // a small standard diff plans one round
    expect(prompt).toContain('bead_id `ov-1`');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 1, verify_status: 'pass', merged_at: null });
    expect(await x.status()).toBe('in_progress');
    expect(await x.phase()).toBe('verifying');
    expect(x.notes).toEqual([]);
    expect(await shAsync(x.repo.path, ['log', '--oneline', 'feature/reviewed'])).not.toContain('Merge'); // not on the batch branch yet

    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c.id);
    await until(() => x.notes.length > 0, WAIT, 'landed'); // the notice is the last step of the landing
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(x.notes).toEqual(['ov-1 landed on feature/reviewed (1/1 beads done; verify command `node -e "process.exit(0)"` passed; reviewed by claude fable)']);
    expect(x.wakes).toEqual(x.notes);
    expect(await shAsync(x.repo.path, ['show', 'feature/reviewed:hello.txt'])).toBe('hi'); // sh trims the output
  });

  it("the critic never runs on the worker's model", async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    x.db.settings.set('tiers', { tiers: [{ name: 'standard', candidates: [{ harness: 'claude', model: 'fable', effort: null }] }, { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }, { harness: 'claude', model: 'opus', effort: null }] }], denyModels: [] });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(() => !!critic(x), WAIT, 'critic session');
    expect(critic(x)).toMatchObject({ harness: 'claude', model: 'opus' });
  });

  it('skips a held harness on the critic path, including the tier fall-through', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    // The worker's model is the critic tier's only candidate, so resolveTier falls through critic → hard, where codex leads.
    // Codex is held: without gating the fall-through tiers the critic lands on it and fails at once, the reported incident.
    x.db.settings.set('tiers', { tiers: [
      { name: 'standard', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
      { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
      { name: 'hard', candidates: [{ harness: 'codex', model: 'gpt-5.6-sol', effort: null }, { harness: 'claude', model: 'opus', effort: null }] },
    ], denyModels: [] });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.sessions.get(sid)).toMatchObject({ harness: 'claude', model: 'fable' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.db.settings.set('harness_limits', { codex: Date.now() + 60 * 60 * 1000 });
    x.finishTurn(sid);
    await until(() => !!critic(x), WAIT, 'critic session');
    expect(critic(x)).toMatchObject({ harness: 'claude', model: 'opus' });
  });

  it('re-dispatches once for evidence problems, then starts one critic after the gate passes', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1, description: 'Write hello.txt\nParity widths: 390' });
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    endWorker(x, first, 'Implemented the greeting.');
    await until(() => workers(x).length === 2, WAIT, 'evidence re-dispatch');

    const retry = workers(x)[1]!;
    const prompt = x.codex.sent(x.sessions.handleOf(retry.id)!)[0]!;
    expect(retry).toMatchObject({ harness: x.db.sessions.get(first)!.harness, tier: 'standard', status: 'running' });
    expect(prompt).toContain('1. The opted-in report contains no Parity line.');
    expect(prompt).toContain('Report the Parity and Evidence lines again for the final HEAD');
    expect(x.db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(1);
    expect(critic(x)).toBeUndefined();
    expect(x.notes).toHaveLength(1);
    expect(x.notes[0]).toContain('evidence gate found 1 problem(s); re-dispatched');

    endWorker(x, retry.id, await validEvidence(x));
    await until(() => !!critic(x), WAIT, 'critic after the evidence gate passes');
    expect(workers(x)).toHaveLength(2);
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ evidence_gate_failures: 0, review_round: 1 });
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'critic')).toHaveLength(1);
    expect(x.notes).toHaveLength(1);
  });

  it('parks after a second consecutive evidence-gate failure without starting a critic', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1, description: 'Write hello.txt\nParity widths: 390' });
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    endWorker(x, first, 'Implemented the greeting.');
    await until(() => workers(x).length === 2, WAIT, 'first evidence re-dispatch');
    endWorker(x, workers(x)[1]!.id, 'Still missing parity evidence.');
    await until(async () => (await x.status()) === 'open', WAIT, 'evidence decision');

    expect(workers(x)).toHaveLength(2);
    expect(critic(x)).toBeUndefined();
    expect(await x.phase()).toBeNull();
    expect(x.db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(2);
    expect(x.wakes).toHaveLength(1);
    expect(x.wakes[0]).toContain('evidence gate failed 2 consecutive times.');
    expect(x.wakes[0]).toContain('1. The opted-in report contains no Parity line.');
    expect(x.wakes[0]).toContain('Totals so far: 2 worker sessions, 0 critic sessions, 1 re-dispatch, cost $0.20 (reported).');
    const notes = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect(notes.match(/Evidence gate: 1 problem\(s\):/g)).toHaveLength(2);
  });

  it('resets the evidence-gate failure count when a non-automatic dispatch starts', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1, description: 'Write hello.txt\nParity widths: 390' });
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    endWorker(x, first, 'Missing parity evidence.');
    await until(() => workers(x).length === 2, WAIT, 'first evidence re-dispatch');
    endWorker(x, workers(x)[1]!.id, 'Still missing parity evidence.');
    await until(async () => (await x.status()) === 'open', WAIT, 'evidence decision');
    expect(x.db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(2);

    const manual = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    expect(x.db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(0);
    endWorker(x, manual, 'Parity evidence is still missing.');
    await until(() => workers(x).length === 4, WAIT, 'new automatic evidence re-dispatch');

    expect(await x.status()).toBe('in_progress');
    expect(x.db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(1);
    expect(x.wakes).toHaveLength(1);
  });

  it('starts the critic directly when an opted-in evidence report passes on the first worker', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1, description: 'Write hello.txt\nParity widths: 390' });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    endWorker(x, sid, await validEvidence(x));
    await until(() => !!critic(x), WAIT, 'first critic');

    expect(workers(x)).toHaveLength(1);
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ evidence_gate_failures: 0, review_round: 1 });
    expect(x.notes).toEqual([]);
  });

  it('keeps the existing path when a bead has no evidence opt-in or Evidence lines', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    endWorker(x, sid, 'Implemented the greeting.');
    await until(() => !!critic(x), WAIT, 'critic without an evidence opt-in');

    expect(workers(x)).toHaveLength(1);
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ evidence_gate_failures: 0, review_round: 1 });
    expect(x.notes).toEqual([]);
  });

  it('reopens an opted-in verify-only bead when the evidence gate fails despite all Check lines passing', async () => {
    const x = setup(undefined, 3, { description: 'Run checks\nParity widths: 390' });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    endWorker(x, sid, 'Check: pnpm test - PASS - Tests 5 passed (5)');
    await until(async () => (await x.status()) === 'open' && x.notes.length > 0, WAIT, 'evidence gate reopen');

    const note = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect({ phase: await x.phase(), session: x.db.sessions.get(sid)?.status, note, notice: x.notes[0] }).toMatchObject({
      phase: null,
      session: 'failed',
      note: expect.stringContaining('Evidence gate: 1 problem(s):\n1. The opted-in report contains no Parity line.'),
      notice: 'ov-1 reopened: verification-only result is incomplete; Evidence gate: 1 problem(s):\n1. The opted-in report contains no Parity line.',
    });
    expect(x.notes).toHaveLength(1);
    expect(x.wakes).toEqual(x.notes);
  });

  it('closes an opted-in verify-only bead as worker-reported when its evidence gate passes', async () => {
    const x = setup(undefined, 3, { description: 'Run checks\nParity widths: 390' });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    endWorker(x, sid, `${await validEvidence(x)}\nCheck: pnpm test - PASS - Tests 5 passed (5)`);
    await until(async () => x.notes.length > 0, WAIT, 'worker-reported close');

    expect({ status: await x.status(), phase: await x.phase(), notice: x.notes[0] }).toEqual({
      status: 'closed',
      phase: 'worker-reported',
      notice: 'ov-1 closed as worker-reported: the worker reported its result and committed nothing.',
    });
  });

  it('closes an opted-in verify-only bead as verified when its command and evidence gate pass', async () => {
    const x = setup(undefined, 3, { description: 'Run checks\nParity widths: 390' });
    const command = `node -e "console.log('Tests 5 passed (5)')"`;
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    endWorker(x, sid, `${await validEvidence(x)}\nCheck: ${command} - PASS - Tests 5 passed (5)`);
    await until(async () => x.notes.length > 0, WAIT, 'verified close');

    expect({ status: await x.status(), phase: await x.phase(), result: x.db.worktrees.get('ov-1')?.verify_only_result, notice: x.notes[0] }).toMatchObject({
      status: 'closed',
      phase: 'verified',
      result: { status: 'pass', command, exit_code: 0 },
      notice: 'ov-1 closed as verified: the daemon ran its verify command and it passed and committed nothing.',
    });
  });

  it('reopens once with both reasons when verify_command and the evidence gate fail', async () => {
    const x = setup(undefined, 3, { description: 'Run checks\nParity widths: 390' });
    const command = `node -e "console.log('Tests 1 failed (1)'); process.exit(3)"`;
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true, verifyCommand: command });
    endWorker(x, sid, `Check: ${command} - PASS - Tests 5 passed (5)`);
    await until(async () => (await x.status()) === 'open' && x.notes.length > 0, WAIT, 'combined verify and evidence failure');

    const note = (await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '';
    expect(note).toContain(`daemon verify command \`${command}\` failed with exit code 3`);
    expect(note).toContain('Evidence gate: 1 problem(s):\n1. The opted-in report contains no Parity line.');
    expect(x.db.worktrees.get('ov-1')?.verify_only_result).toMatchObject({ status: 'fail', command, exit_code: 3 });
    expect(x.notes).toHaveLength(1);
    expect(x.notes[0]).toContain('daemon verify command');
    expect(x.notes[0]).toContain('Evidence gate: 1 problem(s):');
    expect(x.db.sessions.get(sid)?.status).toBe('failed');
  });

  it('does not evidence-re-dispatch a worker stopped during the gate retry', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1, description: 'Write hello.txt\nParity widths: 390' });
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    endWorker(x, first, 'Implemented the greeting.');
    await until(() => workers(x).length === 2, WAIT, 'evidence re-dispatch');

    const retry = workers(x)[1]!;
    await x.lc.interruptBead('ov-1');
    await until(() => x.db.sessions.get(retry.id)?.status === 'ended', WAIT, 'stopped evidence retry');
    expect(workers(x)).toHaveLength(2);
    expect(critic(x)).toBeUndefined();
    expect(x.db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(1);
  });

  it('keeps the first gate-failure count through restart before deciding the next failed attempt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-evidence-gate-adopt-'));
    const dbPath = path.join(tempDir, 'daemon.sqlite');
    const x = setup(undefined, 3, { reviewRounds: 1, dbPath, description: 'Write hello.txt\nParity widths: 390' });
    let restartedDb: ReturnType<typeof openDb> | null = null;
    let originalClosed = false;
    let child: ReturnType<typeof spawnLines> | null = null;
    try {
      const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
      await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
      endWorker(x, first, 'Implemented the greeting.');
      await until(() => workers(x).length === 2, WAIT, 'first evidence re-dispatch');
      const retry = workers(x)[1]!;
      const logFile = path.join(tempDir, 'worker.log');
      child = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
      x.db.sessions.update(retry.id, { pid: child.pid!, pid_started_at: await processStartTime(child.pid!), log_path: logFile, log_offset: 0 });
      x.db.sql.close();
      originalClosed = true;

      const db = openDb(dbPath, { batchIdSuffix: () => '' });
      restartedDb = db;
      const bus = new Bus();
      const sessions = new SessionManager(db, { claude: x.fake, codex: x.codex, opencode: x.opencode }, bus, path.join(tempDir, 'sessions'));
      const notices: string[] = [];
      const lc = new Lifecycle({ db, store: x.store, sessions, bus, config: x.config, provider: () => new LocalMergeProvider(), notify: async (message) => { notices.push(message); }, reapEnded: async () => [] });
      await lc.recover();
      const y = { ...x, db, sessions, lc };
      expect(db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(1);
      expect(sessions.isLive(retry.id)).toBe(true);
      endWorker(y, retry.id, 'Still missing parity evidence.');
      await until(async () => (await y.status()) === 'open', WAIT, 'evidence decision after restart');

      expect(workers(y)).toHaveLength(2);
      expect(critic(y)).toBeUndefined();
      expect(db.worktrees.get('ov-1')?.evidence_gate_failures).toBe(2);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('evidence gate failed 2 consecutive times.');
    } finally {
      if (child) await killProcess(child.pid!).catch(() => {});
      if (restartedDb) restartedDb.sql.close();
      else if (!originalClosed) x.db.sql.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('the first failed round re-dispatches the same model with the findings; findings at the limit park the bead for a decision', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const command = `node -e "process.exit(0)"`;
    const { critic: c1 } = await workerDone(x, 'r1-b1', 'standard', command);
    const findings = [{ file: 'hello.txt', summary: 'The greeting should end in a newline.', severity: 'must' as const }, { file: null, summary: 'No test covers it.', severity: 'should' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    const w2 = workers(x)[1]!;
    expect(w2).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra', tier: 'standard', status: 'running', verify_only: 1 }); // the first round stays on the model that did the work; escalation waits for the next one
    const prompt = x.codex.sent(x.sessions.handleOf(w2.id)!)[0]!;
    expect(prompt).toContain(renderFindings(findings));
    expect(prompt).toContain('- [must] hello.txt: The greeting should end in a newline.');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 1, batch_id: 'r1-b1', review_findings: null, verify_command: command });
    expect(x.notes).toEqual([`ov-1 review round 1 of 2 (claude fable) found issues; re-dispatched to codex gpt-5.6-terra with them:\n${renderFindings(findings)}`]);
    expect(x.wakes).toEqual([]); // queued: the orchestrator has nothing to decide yet

    // The second worker adds nothing new; the branch still has commits, so it is verified and reviewed again.
    x.codex.emit(x.sessions.handleOf(w2.id)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'second critic');
    const c2 = critic(x)!;
    expect(x.fake.sent(x.sessions.handleOf(c2.id)!)[0]).toContain('review round 2 of 2');
    expect(x.fake.sent(x.sessions.handleOf(c2.id)!)[0]).toContain('- [must] hello.txt: The greeting should end in a newline.'); // the instructions the worker got
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: [findings[0]!] });
    endCritic(x, c2.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked');
    expect(await x.phase()).toBeNull();
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 2, review_findings: [findings[0]], merged_at: null });
    expect(workers(x)).toHaveLength(2);
    expect(x.wakes).toEqual([`ov-1 awaits a decision: review round 2 of 2 (claude fable) still has findings:\n${renderFindings([findings[0]!])}\nTotals so far: 2 worker sessions, 2 critic sessions, 1 re-dispatch, cost $0.60 (reported).`]);
    expect(x.hints.at(-1)).toContain('accept_review');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Review round 2 of 2 (claude fable) still has findings');

    // accept_review lands it as it is.
    await x.lc.acceptReview('r1', 'ov-1', 'Good enough for the demo.');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ accepted_note: 'Good enough for the demo.', review_round: null, review_findings: null });
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/reviewed (1/1 beads done; verify command `node -e "process.exit(0)"` passed; landed with open findings by the user through the orchestrator)');
    await expect(x.lc.acceptReview('r1', 'ov-1', 'again')).rejects.toThrow(/no open review findings/);
  });

  it('the awaits-a-decision notice carries the bead totals: worker and critic sessions, re-dispatches and reported cost', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    const { critic: c1 } = await workerDone(x);
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    x.codex.emit(x.sessions.handleOf(workers(x)[1]!.id)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'second critic');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    endCritic(x, critic(x)!.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked');
    expect(x.wakes.at(-1)).toContain('Totals so far: 2 worker sessions, 2 critic sessions, 1 re-dispatch, cost $0.60 (reported).');
  });

  it('a bead whose sessions carry no reported or estimated cost says so in the notice instead of printing $0', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Added hello.txt' });
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1' }); // no cost and no usage
    await until(() => !!critic(x), WAIT, 'critic');
    const c = critic(x)!;
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    x.fake.emit(x.sessions.handleOf(c.id)!, { type: 'turn_end', nativeSessionId: 'c1' }); // no cost either
    await until(() => x.wakes.length === 1, WAIT, 'parked');
    expect(x.db.sessions.forBead('ov-1').every((s) => s.cost === null && s.estimated_cost === null)).toBe(true);
    expect(x.wakes.at(-1)).toContain('Totals so far: 1 worker session, 1 critic session, 0 re-dispatches, cost unknown (no reported or estimated cost).');
    expect(x.wakes.at(-1)).not.toContain('$0.00');
  });

  it('labels the bead cost estimated when its sessions reported none but a catalog priced them', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-prices-')), 'models.dev.json');
    fs.writeFileSync(file, JSON.stringify({ openai: { models: { 'gpt-5.6-terra': { cost: { input: 5, output: 20 } } } }, anthropic: { models: { fable: { cost: { input: 3, output: 15 } } } } }));
    const catalog = new PriceCatalog(file);
    expect(catalog.load()).toBe(true);
    const x = setup(undefined, 3, { reviewRounds: 1, prices: catalog });
    x.db.settings.set('tiers', { tiers: [
      { name: 'standard', candidates: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: null }] },
      { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
    ], denyModels: [] });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', usage: { input: 1000, output: 500 } }); // no reported cost
    await until(() => !!critic(x), WAIT, 'critic');
    const c = critic(x)!;
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: mustFindings });
    x.fake.emit(x.sessions.handleOf(c.id)!, { type: 'turn_end', nativeSessionId: 'c1', usage: { input: 1000, output: 500 } }); // no reported cost
    await until(() => x.wakes.length === 1, WAIT, 'parked');
    expect(x.db.sessions.forBead('ov-1').every((s) => s.cost === null && s.estimated_cost !== null)).toBe(true);
    expect(x.wakes.at(-1)).toContain('Totals so far: 1 worker session, 1 critic session, 0 re-dispatches, cost $0.03 (estimated).');
  });

  it('a round whose findings carry no must lands the bead, with the findings on its notes and in the landing notice', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const { critic: c1 } = await workerDone(x, 'r1-b1');
    const findings = [{ file: 'hello.txt', summary: 'No test covers the greeting.', severity: 'should' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, c1.id);
    await until(() => x.notes.some((n) => n.startsWith('ov-1 landed')), WAIT, 'landed');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(workers(x)).toHaveLength(1);
    expect(x.db.worktrees.get('ov-1')?.merged_at).toBeTruthy();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain(`Review findings landed with (round 1):\n${renderFindings(findings)}`);
    expect(x.notes.at(-1)).toBe(`ov-1 landed on feature/reviewed (1/1 beads done; verify command \`node -e "process.exit(0)"\` passed; reviewed by claude fable; review findings landed with (round 1):\n${renderFindings(findings)})`);
  });

  /** Lands ov-1 with the given review while bd's close fails once, and waits for the landed-but-unrecorded notice. */
  async function landWithFailedClose(x: ReturnType<typeof setup>, review: Parameters<Lifecycle['recordReview']>[1]): Promise<void> {
    await x.lc.createBatch('r1', 'Reviewed');
    const { critic: c1 } = await workerDone(x, 'r1-b1');
    vi.spyOn(x.store, 'close').mockRejectedValueOnce(new Error('bd close failed'));
    const error = scopedSpy(console, 'error').mockImplementation(() => {});
    x.lc.recordReview('ov-1', review);
    endCritic(x, c1.id);
    try {
      await until(() => x.notes.at(-1)?.includes('could not record it') ?? false, WAIT, 'reported');
    } finally {
      error.mockRestore();
    }
    expect(await x.status()).toBe('in_progress');
  }

  const shouldFindings = [{ file: 'hello.txt', summary: 'No test covers the greeting.', severity: 'should' as const }];
  const landedHeading = `Review findings landed with (round 1):\n${renderFindings(shouldFindings)}`;
  const landedNotice = `ov-1 landed on feature/reviewed (1/1 beads done; verify command \`node -e "process.exit(0)"\` passed; reviewed by claude fable; review findings landed with (round 1):\n${renderFindings(shouldFindings)})`;
  const occurrences = (text: string, part: string) => text.split(part).length - 1;

  it('should-only findings whose close fails are written to the notes and the notice once by Retry close', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await landWithFailedClose(x, { verdict: 'findings', findings: shouldFindings });
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '').not.toContain('Review findings landed with');
    await x.lc.closeLanded('ov-1');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(occurrences((await x.store.show(x.repo.path, 'ov-1'))!.notes ?? '', landedHeading)).toBe(1);
    expect(x.notes.at(-1)).toBe(landedNotice);
    expect(x.notes.filter((n) => n.startsWith('ov-1 landed on') && !n.includes('could not record it'))).toEqual([landedNotice]);
  });

  it('should-only findings whose close fails are written to the notes and the notice once by restart recovery', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await landWithFailedClose(x, { verdict: 'findings', findings: shouldFindings });
    const wtPath = x.db.worktrees.get('ov-1')!.path;
    const notices: string[] = [];
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: { ...loadConfig({}), worktreesDir: path.dirname(path.dirname(wtPath)) }, provider: () => new LocalMergeProvider(), notify: async (text: string) => { notices.push(text); } });
    await fresh.recover();
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect(occurrences((await x.store.show(x.repo.path, 'ov-1'))!.notes ?? '', landedHeading)).toBe(1);
    expect(notices.filter((n) => n.startsWith('ov-1 landed on'))).toEqual([landedNotice]);
  });

  it('a clean review pass whose close fails lands on Retry close with no findings note or findings in the notice', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await landWithFailedClose(x, { verdict: 'pass', findings: [] });
    await x.lc.closeLanded('ov-1');
    expect(await x.status()).toBe('closed');
    expect(await x.phase()).toBe('merged');
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes ?? '').not.toContain('Review findings landed with');
    expect(x.notes.at(-1)).toBe('ov-1 landed on feature/reviewed (1/1 beads done; verify command `node -e "process.exit(0)"` passed)');
  });

  it('should-only findings that fail to merge leave no landed-with note on the reopened bead', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    const failing = `node -e "process.exit(1)"`;
    x.db.repos.update('r1', { setup_command: failing }); // fails at create_batch, so it runs again before the first merge
    await x.lc.createBatch('r1', 'Reviewed');
    x.db.repos.update('r1', { setup_command: null }); // the bead's own worktree needs none
    const { critic: c1 } = await workerDone(x, 'r1-b1');
    x.db.repos.update('r1', { setup_command: failing });
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: 'hello.txt', summary: 'No test covers the greeting.', severity: 'should' }] });
    endCritic(x, c1.id);
    await until(async () => (await x.status()) === 'open' && (await x.phase()) === null, WAIT, 'reopened');
    const notes = (await x.store.show(x.repo.path, 'ov-1'))!.notes;
    expect(notes).toContain('Setup failed in the batch worktree of r1-b1');
    expect(notes).not.toContain('Review findings landed with');
    expect(x.db.worktrees.get('ov-1')?.merged_at).toBeNull();
  });

  for (const [name, findings] of [
    ['a must finding', [{ file: 'hello.txt', summary: 'Broken.', severity: 'must' }]],
    ['a mix of must and should', [{ file: 'hello.txt', summary: 'Broken.', severity: 'must' }, { file: null, summary: 'Untested.', severity: 'should' }]],
    ['an unparseable severity', [{ file: null, summary: 'Untested.', severity: 'should' }, { file: 'hello.txt', summary: 'Hmm.', severity: 'maybe' }]],
  ] as const) {
  it(`${name} re-dispatches the worker instead of landing`, async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const { critic: c1 } = await workerDone(x, 'r1-b1');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: findings as never });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    expect(x.db.worktrees.get('ov-1')?.merged_at).toBeNull();
    expect(x.notes.at(-1)).toContain('found issues; re-dispatched');
  });
  }

  /** The resume id the adapter was started with, or undefined when it was started afresh. */
  const resumeIdOf = (x: ReturnType<typeof setup>, sessionId: string) => x.codex.sessions.get(x.sessions.handleOf(sessionId)!.id)!.opts.resumeId;

  it('the first failed round resumes the worker session that did the work', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const { sid, critic: c1 } = await workerDone(x, 'r1-b1');
    expect(x.db.sessions.get(sid)).toMatchObject({ model: 'gpt-5.6-terra', native_session_id: 'n1' });
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: null, summary: 'No test covers it.', severity: 'must' as const }] });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    expect(resumeIdOf(x, workers(x)[1]!.id)).toBe('n1');
  });

  it('a later failed round of a hard bead moves to a fresh model and does not resume', async () => {
    const x = setup(undefined, 3, { reviewRounds: 3 });
    await x.lc.createBatch('r1', 'Reviewed');
    const { critic: c1 } = await workerDone(x, 'r1-b1', 'hard');
    const findings = [{ file: null, summary: 'No test covers it.', severity: 'must' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, c1.id);
    await until(() => workers(x).length === 2, WAIT, 'first re-dispatch');

    // The second worker adds nothing new; the branch still has commits, so it is verified and reviewed again.
    x.codex.emit(x.sessions.handleOf(workers(x)[1]!.id)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'second critic');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 3, WAIT, 'second re-dispatch');
    const w3 = workers(x)[2]!;
    expect(w3).toMatchObject({ harness: 'claude', model: 'opus', tier: 'hard' }); // the hard tier's other candidate: sol already failed
    expect(x.fake.sessions.get(x.sessions.handleOf(w3.id)!.id)!.opts.resumeId).toBeUndefined();
  });

  it('the first failed round starts afresh when the worker session left no resume id', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    // codex and opencode report an empty id when the CLI gave them no thread to resume (`?? ''` in both adapters).
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: '', cost: 0.1 });
    await until(() => !!critic(x), WAIT, 'critic session');
    expect(x.db.sessions.get(sid)!.native_session_id).toBe('');
    x.lc.recordReview('ov-1', { verdict: 'findings', findings: [{ file: null, summary: 'No test covers it.', severity: 'must' as const }] });
    endCritic(x, critic(x)!.id);
    await until(() => workers(x).length === 2, WAIT, 're-dispatch');
    const w2 = workers(x)[1]!;
    expect(w2).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra', status: 'running' });
    expect(resumeIdOf(x, w2.id)).toBeUndefined();
  });

  it('a critic that ends without a verdict counts as a must finding, and its edits are discarded before the work lands', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const { wt, critic: c1 } = await workerDone(x); // no batch: landing is the user's review
    fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'critic edit\n');
    fs.writeFileSync(path.join(wt.path, 'junk.txt'), 'left by the critic\n');
    x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'assistant_text', text: 'I ran out of time.' });
    endCritic(x, c1.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked');
    expect(x.db.worktrees.get('ov-1')?.review_findings).toEqual([{ file: null, summary: 'I ran out of time.', severity: 'must' }]);
    expect(fs.readFileSync(path.join(wt.path, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(fs.existsSync(path.join(wt.path, 'junk.txt'))).toBe(false);
    expect(() => x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] })).toThrow(/no critic session is reviewing ov-1/);

    await x.lc.acceptReview('r1', 'ov-1', 'Ship it.');
    expect(await x.status()).toBe('in_progress');
    expect(await x.phase()).toBe('review');
    expect(x.notes.at(-1)).toBe('ov-1 is in review; verify command `node -e "process.exit(0)"` passed; landed with open findings by the user through the orchestrator');
    await x.lc.requestMerge('r1', 'ov-1', 'Adds hello.txt');
    await x.lc.merge('ov-1');
    expect(fs.readFileSync(path.join(x.repo.path, 'hello.txt'), 'utf8')).toBe('hi\n');
  });

  it('a critic that fails reopens the bead with the failure instead of a synthesised finding (final review I-1)', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    const errors = scopedSpy(log, 'error').mockImplementation(() => {});
    try {
      const { critic: c1 } = await workerDone(x);
      x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'error', message: 'exited with code 1' });
      await x.fake.end(x.sessions.handleOf(c1.id)!); // the CLI died: no turn_end, no submit_review
      await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
      expect(x.db.sessions.get(c1.id)?.status).toBe('failed');
      expect(await x.phase()).toBeNull();
      expect(workers(x)).toHaveLength(1); // not re-dispatched
      expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 1, review_findings: null, merged_at: null }); // not parked either
      expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Review round on claude failed: the critic session failed: exited with code 1');
      expect(x.wakes).toEqual(['ov-1 reopened: its review round on claude could not be completed: the critic session failed: exited with code 1']);
    } finally {
      errors.mockRestore();
    }
  });

  it('auth: a critic that ends on a rolled-over token re-runs its round without spending one', async () => {
    const usageGate = vi.fn<typeof accountUsable>(async () => ({ usable: true }));
    const x = setup(undefined, 3, { reviewRounds: 2, usageGate });
    x.db.accounts.insert({ id: 'crit-roll', name: 'Critic Rollover', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeCriticAccount(x, 'crit-roll');
    const { critic: c1 } = await workerDone(x);
    expect(c1.account).toBe('crit-roll');
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1);
    x.db.accounts.update('crit-roll', { token_expires_at: Date.now() + 4 * 60 * 60_000 }); // rolled over
    emitAuthTurn(x, c1.id, 'crit-native');
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.role === 'critic').length === 2 && !!critic(x) && critic(x)!.id !== c1.id, WAIT, 're-run critic');
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1); // the same round, not a new one
    expect(x.db.accounts.get('crit-roll')?.exhausted_until ?? null).toBeNull();
    expect(await x.status()).toBe('in_progress'); // not reopened
    expect(x.notes).toContain('ov-1 resumed after its login token rolled over on claude account Critic Rollover.');
    expect(critic(x)!.auth_resumed).toBe(1); // written as the re-run row is created, before the round's own awaits
    expect(usageGate.mock.calls.filter((call) => call[2] === 'crit-roll' && call[3] === 'fable').length).toBeGreaterThanOrEqual(3);
  });

  it('auth: a critic round blocked by the usage gate reopens without parking the refreshed account', async () => {
    let blockUsage = false;
    const usageGate = vi.fn<typeof accountUsable>(async (_db, _config, accountId) => blockUsage && accountId === 'crit-gated'
      ? { usable: false, reason: 'account Critic Gated: session 83% >= 83% (85% - 1 running x 2%)' }
      : { usable: true });
    const x = setup(undefined, 3, { reviewRounds: 2, usageGate });
    x.db.accounts.insert({ id: 'crit-gated', name: 'Critic Gated', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeCriticAccount(x, 'crit-gated');
    const { critic: c1 } = await workerDone(x);
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) tier.candidates = [{ harness: 'claude', model: 'fable', effort: null, account: 'crit-gated' }];
    x.db.settings.set('tiers', tiers);
    blockUsage = true;
    x.db.accounts.update('crit-gated', { token_expires_at: Date.now() + 4 * 60 * 60_000 });

    emitAuthTurn(x, c1.id, 'crit-gated-native');

    await until(async () => (await x.status()) === 'open', WAIT, 'critic reopened after usage-gated auth resume');
    expect(x.db.sessions.forBead('ov-1').filter((session) => session.role === 'critic')).toHaveLength(1);
    expect(usageGate.mock.calls.filter((call) => call[2] === 'crit-gated' && call[3] === 'fable').length).toBeGreaterThanOrEqual(3);
    expect(usageGate.mock.calls.some((call) => call[6] === c1.id)).toBe(true);
    expect(x.db.accounts.get('crit-gated')?.exhausted_until ?? null).toBeNull();
    expect(x.notes.at(-1)).toContain('auth resume skipped:');
    expect(x.notes.at(-1)).toContain('session 83% >= 83%');
  });

  it('auth: a critic re-run rejected at once parks the account instead of running a third round', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    x.db.accounts.insert({ id: 'crit-now', name: 'Critic Now', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeCriticAccount(x, 'crit-now');
    const { critic: c1 } = await workerDone(x);
    x.db.accounts.update('crit-now', { token_expires_at: Date.now() + 4 * 60 * 60_000 }); // rolled over
    emitAuthTurn(x, c1.id, 'crit-native');
    await until(() => !!(critic(x) && critic(x)!.id !== c1.id), WAIT, 're-run critic');
    const c2 = critic(x)!;
    expect(c2.auth_resumed).toBe(1);
    // The re-run is rejected at once: the one resume is spent, so the account parks and no third critic starts.
    emitAuthTurn(x, c2.id, 'crit-native');
    await until(() => x.db.accounts.get('crit-now')?.exhausted_until === AUTH_HOLD_UNTIL, WAIT, 'parked after the re-run was rejected');
    await new Promise((resolve) => setImmediate(resolve));
    expect(x.db.sessions.forBead('ov-1').filter((s) => s.role === 'critic')).toHaveLength(2); // no third round
  });

  it('auth: a critic report that quotes a 401 is not an auth failure and parks nothing', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    x.db.accounts.insert({ id: 'crit-healthy', name: 'Critic Healthy', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'r', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    claudeCriticAccount(x, 'crit-healthy');
    const { critic: c1 } = await workerDone(x);
    x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'assistant_text', text: 'The change looks fine. I also noted the probe output: Failed to authenticate. API Error: 401 OAuth access token has expired.' });
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c1.id);
    await until(async () => (await x.phase()) === 'review', WAIT, 'passed review');
    expect(x.notes.some((n) => n.includes('ov-1 is in review'))).toBe(true);
    expect(x.db.accounts.get('crit-healthy')?.exhausted_until ?? null).toBeNull();
    expect(x.notes.some((n) => n.includes('could not authenticate'))).toBe(false);
    expect(x.notes.some((n) => n.includes('resumed after its login token rolled over'))).toBe(false);
  });

  it('names the critic session\'s account when its review round could not be completed', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    scopedSpy(log, 'error');
    const server = await tokenServer(401, '{"error":"invalid_grant"}');
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = server.url;
    try {
      x.db.accounts.insert({ id: 'c1', name: 'Work', harness: 'claude', kind: 'oauth_token', secret: 'stale-access', refresh_token: 'live-refresh', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
      claudeCriticAccount(x, 'c1');
      const { critic: c1 } = await workerDone(x);
      // The token lapses and its refresh is revoked only after the round started, so the critic spawned normally.
      x.db.accounts.update('c1', { token_expires_at: Date.now() - 1, refresh_token: 'revoked-refresh' });
      emitAuthTurn(x, c1.id, 'crit-park');
      await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
      expect(x.wakes).toEqual(['ov-1 reopened: its review round on claude account Work could not be completed: the critic session failed: Failed to authenticate. API Error: 401 OAuth access token has been revoked.']);
      // The refresh was rejected, so the round fails and parks the account for a re-login, recorded as an auth crash.
      await until(() => x.db.accounts.get('c1')?.exhausted_until === AUTH_HOLD_UNTIL && x.db.sessions.get(c1.id)?.crash_class === 'auth', WAIT, 'critic account parked');
      expect(x.notes.some((n) => n.includes('could not authenticate') && n.includes('claude account Work'))).toBe(true);
      expect(server.requests.some((r) => r.refresh_token === 'revoked-refresh')).toBe(true);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await server.close();
    }
  });

  it('recover resumes the interrupted review round instead of counting it twice (final review I-2)', async () => {
    const x = setup(undefined, 3, { reviewRounds: 2 });
    const { critic: c1 } = await workerDone(x);
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1);
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m, o) => { x.notes.push(m); if (o?.wake) x.wakes.push(m); } });
    await fresh.recover();
    await until(() => !!critic(x) && critic(x)!.id !== c1.id, WAIT, 'fresh critic session');
    expect(x.db.worktrees.get('ov-1')?.review_round).toBe(1); // the same round, not 2
    expect(x.fake.sent(x.sessions.handleOf(critic(x)!.id)!)[0]).toContain('review round 1 of 1');
  });

  it('a refused automatic re-dispatch (worker limit) parks the bead with the findings instead of dropping them; Retry verification starts the rounds afresh (final review I-3, M-1)', async () => {
    const x = setup(undefined, 1, { reviewRounds: 2 });
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Other', description: 'Write other.txt' });
    const { critic: c1 } = await workerDone(x);
    await x.lc.spawnWorker('r1', 'ov-2', { tier: 'standard' }); // the only worker slot is taken while the critic runs
    const findings = [{ file: 'hello.txt', summary: 'The greeting should end in a newline.', severity: 'must' as const }];
    x.lc.recordReview('ov-1', { verdict: 'findings', findings });
    endCritic(x, c1.id);
    await until(async () => (await x.status()) === 'open', WAIT, 'parked');
    expect(await x.phase()).toBeNull();
    expect(workers(x)).toHaveLength(1); // the re-dispatch was refused
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 1, review_findings: findings, merged_at: null });
    const card = (await buildBoard(x.db, x.store)).repos[0]!.cards.find((c) => c.bead.id === 'ov-1')!;
    expect(card.state).toBe('awaiting_decision');
    expect(x.wakes).toEqual(['ov-1 awaits a decision: review round 1 of 2 (claude fable) found issues, and the re-dispatch was refused: worker limit 1 reached for r1.\nTotals so far: 1 worker session, 1 critic session, 0 re-dispatches, cost $0.30 (reported).']);
    expect(x.hints.at(-1)).toContain(renderFindings(findings));
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('the re-dispatch was refused (worker limit 1 reached for r1)');

    // M-1: Retry verification clears the parked findings and the round count, so the next review is round 1 again, not "round 2 of 2".
    x.db.worktrees.update('ov-1', { review_diff_lines: 999 }); // a stale measurement from the cycle that just ended
    await x.lc.reverify('ov-1');
    await until(() => !!critic(x), WAIT, 'critic after the retry');
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ review_round: 1, review_findings: null, review_diff_lines: 1 }); // measured afresh
    expect(x.fake.sent(x.sessions.handleOf(critic(x)!.id)!)[0]).toContain('review round 1 of 1');
  });

  it('a critic pass on a bead without a batch puts it in review, naming the critic', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const { critic: c } = await workerDone(x);
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    endCritic(x, c.id);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed; reviewed by claude fable']);
  });

  it('a failed verification reopens the bead without a review round', async () => {
    const x = setup(`node -e "process.exit(1)"`, 3, { reviewRounds: 2 });
    await x.lc.createBatch('r1', 'Reviewed');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    expect(x.db.sessions.forBead('ov-1').map((s) => s.role)).toEqual(['worker']);
    expect(x.db.worktrees.get('ov-1')).toMatchObject({ verify_status: 'fail', review_round: null });
  });

  it('review_rounds 0 lands with no critic session', async () => {
    const x = setup(undefined, 3, { reviewRounds: 0 });
    await x.lc.createBatch('r1', 'Plain');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard', batchId: 'r1-b1' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.codex.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => x.notes.length > 0, WAIT, 'landed');
    expect(await x.status()).toBe('closed');
    expect(x.db.sessions.forBead('ov-1').map((s) => s.role)).toEqual(['worker']);
    expect(x.notes).toEqual(['ov-1 landed on feature/plain (1/1 beads done; verify command `node -e "process.exit(0)"` passed)']);
  });

  it('recover restarts a critic session lost with the daemon instead of routing it through the worker-ended path', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const { wt, critic: c1 } = await workerDone(x);
    const fresh = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: x.bus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m, o) => { x.notes.push(m); if (o?.wake) x.wakes.push(m); } });
    await fresh.recover();
    expect(x.db.sessions.get(c1.id)?.status).toBe('ended');
    await until(() => !!critic(x), WAIT, 'fresh critic session');
    const c2 = critic(x)!;
    expect(c2.id).not.toBe(c1.id);
    expect(c2).toMatchObject({ harness: 'claude', model: 'fable', tier: 'critic', cwd: wt.path });
    expect(await x.status()).toBe('in_progress'); // not reopened and not landed: recovery only restarted the critic
  });

  it('interruptBead on a bead under review reopens it without landing and without re-dispatching a worker', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    await workerDone(x);
    await x.lc.interruptBead('ov-1'); // interrupt() ends the session itself; no manual turn_end needed
    await until(async () => (await x.status()) === 'open', WAIT, 'reopened');
    expect(await x.phase()).toBeNull();
    expect((await x.store.show(x.repo.path, 'ov-1'))?.notes).toContain('Stopped during review by the user');
    expect(x.notes).toEqual(['ov-1 stopped during review by the user; reopened without landing.']);
    expect(x.wakes).toEqual(x.notes);
    expect(workers(x)).toHaveLength(1); // no re-dispatch
    expect(x.db.worktrees.get('ov-1')?.merged_at).toBeNull();
  });

  it('a batch bead mid-review or awaiting a decision counts as outstanding for request_batch_review', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    await x.lc.createBatch('r1', 'Reviewed');
    await workerDone(x, 'r1-b1');
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'n')).rejects.toThrow(/still open/); // a running critic: mid-review

    const c1 = critic(x)!;
    x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'assistant_text', text: 'Needs another look.' });
    x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'turn_end', nativeSessionId: 'c1', cost: 0.1 });
    await until(async () => (await x.status()) === 'open', WAIT, 'parked'); // findings without a verdict, at the review-round limit
    expect(x.db.worktrees.get('ov-1')?.review_findings).toBeTruthy();
    await expect(x.lc.requestBatchReview('r1', 'r1-b1', 'n')).rejects.toThrow(/still open/); // awaiting the user's decision
  });

  it('redispatch of a bead awaiting a decision carries the review findings, not nothing, and steps up the tier', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    await workerDone(x);
    const c1 = critic(x)!;
    x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'assistant_text', text: 'Needs another look.' });
    x.fake.emit(x.sessions.handleOf(c1.id)!, { type: 'turn_end', nativeSessionId: 'c1', cost: 0.1 });
    await until(async () => (await x.status()) === 'open', WAIT, 'parked'); // findings without a verdict, at the review-round limit
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('pass'); // verification passed; only the review found issues

    const sid2 = await x.lc.redispatch('ov-1');
    // The step-up shows in the model: the first worker got the standard tier's first model (terra); a stepped-up
    // re-dispatch skips it for the hard tier's first fresh model, same as a failed-verification re-dispatch does.
    expect(x.db.sessions.get(sid2)).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol', tier: 'standard' });
    const prompt = x.codex.sent(x.sessions.handleOf(sid2)!)[0]!;
    expect(prompt).toContain('Needs another look.');
    expect(x.notes.at(-1)).toContain('with the review findings');
  });
});

describe.concurrent('Lifecycle worktree cleanup', () => {
  it('batches: a bead folder git no longer lists as a worktree is cleared once, without an error on every later pass', async () => {
    const x = setup();
    const errors = scopedSpy(log, 'error').mockImplementation(() => {});
    try {
      await x.lc.createBatch('r1', 'Trend chart');
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
      const wt = x.db.worktrees.get('ov-1')!;
      await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
      x.finishTurn(sid);
      await until(() => x.notes.at(-1)?.includes('landed on') ?? false, WAIT, 'integrated');
      expect(fs.existsSync(wt.path)).toBe(false);
      // Windows can keep the folder (a scanner holds a file) after git has dropped its worktree entry: the path exists, git says
      // "is not a working tree", and every later cleanup of the batch logged that and tried again.
      fs.mkdirSync(wt.path, { recursive: true });
      fs.writeFileSync(path.join(wt.path, 'leftover.txt'), 'x');
      await x.lc.requestBatchReview('r1', 'r1-b1', 'Adds hello.txt');
      await x.lc.mergeBatch('r1-b1');
      expect(errors.mock.calls.map((c) => c[0])).not.toContainEqual(expect.stringContaining('could not remove'));
      expect(fs.existsSync(wt.path)).toBe(false);
      expect(x.db.worktrees.get('ov-1')).toMatchObject({ batch_id: 'r1-b1', merged_at: expect.any(String) });
    } finally {
      errors.mockRestore();
    }
  });
});

describe('Lifecycle finished-worktree process cleanup', () => {
  const tracker = () => {
    const paths: string[] = [];
    const reapEnded: NonNullable<LifecycleDeps['reapEnded']> = async (_deps, worktree) => { paths.push(worktree); return []; };
    return { paths, reapEnded };
  };

  it('ends processes before removing a verify-only bead worktree', async () => {
    const tracked = tracker();
    const x = setup(undefined, 3, tracked);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', verifyOnly: true });
    const wt = x.db.worktrees.get('ov-1')!;
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'assistant_text', text: 'Check: pnpm test - PASS - Tests 5 passed (5)' });
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'worker-reported', WAIT, 'worker-reported close');
    expect(tracked.paths).toContain(wt.path);
  });

  it('ends processes before removing a bead worktree after it lands on a batch', async () => {
    const tracked = tracker();
    const x = setup(undefined, 3, tracked);
    await x.lc.createBatch('r1', 'Trend chart');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'merged', WAIT, 'batch landing');
    expect(tracked.paths).toContain(wt.path);
  });

  it('ends processes before removing a manually closed bead worktree', async () => {
    const tracked = tracker();
    const x = setup(undefined, 3, tracked);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open', WAIT, 'worker reopened');
    await x.lc.closeBead('ov-1');
    expect(tracked.paths).toContain(wt.path);
  });

  it('ends processes before standalone merge() removes its bead worktree', async () => {
    const tracked = tracker();
    const x = setup(undefined, 3, tracked);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    await x.lc.requestMerge('r1', 'ov-1', 'Adds hello.txt');
    await x.lc.merge('ov-1');
    expect(tracked.paths).toContain(wt.path);
  });

  it('ends processes in the batch worktree when the batch merges', async () => {
    const tracked = tracker();
    const x = setup(undefined, 3, tracked);
    const batch = await x.lc.createBatch('r1', 'Trend chart');
    const batchPath = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: batch.id });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'merged', WAIT, 'batch landing');
    tracked.paths.length = 0;
    await x.lc.requestBatchReview('r1', batch.id, 'Adds hello.txt');
    await x.lc.mergeBatch(batch.id);
    expect(tracked.paths).toContain(batchPath);
  });

  it('ends processes in bead and batch worktrees when the batch is abandoned', async () => {
    const tracked = tracker();
    const x = setup(undefined, 3, tracked);
    const batch = await x.lc.createBatch('r1', 'Trend chart');
    const batchPath = batchWorktreePath(x.worktreesDir, 'r1', batch.id);
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: batch.id });
    const beadPath = x.db.worktrees.get('ov-1')!.path;
    await x.lc.abandonBatch(batch.id);
    expect(tracked.paths).toEqual(expect.arrayContaining([beadPath, batchPath]));
  });

  it('reports a process-cleanup failure without breaking standalone merge()', async () => {
    const cleanupError = new Error('process listing failed');
    const x = setup(undefined, 3, { reapEnded: async () => { throw cleanupError; } });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    await x.lc.requestMerge('r1', 'ov-1', 'Adds hello.txt');
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await expect(x.lc.merge('ov-1')).resolves.toEqual({ mrUrl: undefined });
      expect(errors).toHaveBeenCalledWith(`lifecycle: could not end processes left in ${wt.path}`, cleanupError);
      expect(await x.phase()).toBe('merged');
    } finally {
      errors.mockRestore();
    }
  });

  it('reports a worktree-removal failure without breaking standalone merge()', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    await commitFileAsync(wt.path, 'hello.txt', 'hi\n', 'add greeting');
    x.finishTurn(sid);
    await until(async () => (await x.phase()) === 'review', WAIT, 'review');
    await x.lc.requestMerge('r1', 'ov-1', 'Adds hello.txt');
    // A locked worktree is a removal failure the other landing paths already tolerate: `git worktree remove --force` refuses
    // it (unlike a folder git has already forgotten), and the retry refuses it too.
    await shAsync(x.repo.path, ['worktree', 'lock', wt.path]);
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await expect(x.lc.merge('ov-1')).resolves.toEqual({ mrUrl: undefined });
      expect(errors.mock.calls.map((c) => c[0])).toContainEqual(`lifecycle: could not remove ${wt.path}`);
      expect(await x.phase()).toBe('merged');
    } finally {
      errors.mockRestore();
      await shAsync(x.repo.path, ['worktree', 'unlock', wt.path]);
    }
  });
});

// A commit-msg hook such as commitlint runs `npx --no -- commitlint`, which needs the repo's node_modules; a batch worktree
// created bare had none, so every merge into the batch stopped with "Not committing merge" (overseer-ldh). The setup command
// is the daemon's way to give each new worktree what the hooks and the verify command need.
describe.concurrent('setup command', () => {
  const marker = `node -e "require('fs').writeFileSync('setup.txt', 'ok')"`;
  const failing = `node -e "console.error('npx canceled due to missing packages'); process.exit(1)"`;

  it('runs in the batch worktree at create_batch and in each new bead worktree at dispatch', async () => {
    const x = setup();
    x.db.repos.update('r1', { setup_command: marker });
    const b = await x.lc.createBatch('r1', 'Deps');
    expect(fs.existsSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', b.id), 'setup.txt'))).toBe(true);
    expect(x.db.batches.get(b.id)?.setup_at).toBeTruthy();
    await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: b.id });
    expect(fs.existsSync(path.join(x.db.worktrees.get('ov-1')!.path, 'setup.txt'))).toBe(true);
    expect(x.notes).toEqual([]);
  });

  it('a failing setup at create_batch keeps the batch, names the command, and runs again before the first merge', async () => {
    const x = setup();
    x.db.repos.update('r1', { setup_command: failing });
    const b = await x.lc.createBatch('r1', 'Deps');
    expect(x.db.batches.get(b.id)?.setup_at).toBeNull();
    expect(x.wakes.at(-1)).toMatch(/^Batch r1-b1 was created, but the setup command `node -e "console\.error\('npx canceled due to missing packages'\); process\.exit\(1\)"` failed in its worktree [^\n]*\.\n\$ node -e [^\n]*\nnpx canceled due to missing packages\n\nexit 1\nIt runs again before the first bead merges into feature\/deps/);
    x.db.repos.update('r1', { setup_command: null }); // the bead's own worktree needs none for this test
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: b.id });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'x.txt', 'x\n', 'x');
    x.db.repos.update('r1', { setup_command: failing });
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && (await x.phase()) === null, WAIT, 'reopened');
    const notes = (await x.store.show(x.repo.path, 'ov-1'))!.notes;
    expect(notes).toMatch(/Setup failed in the batch worktree of r1-b1, so bead\/ov-1 was not merged into feature\/deps:\n\$ node -e .*\nnpx canceled due to missing packages/);
    expect(x.wakes.at(-1)).toMatch(/^ov-1 reopened: the setup command `.*` failed in the batch worktree of r1-b1, so its branch was not merged into feature\/deps\./);
    expect(x.hints.at(-1)).toMatch(/Retry verification/);
    expect(x.db.worktrees.get('ov-1')?.verify_status).toBe('pass'); // the work was fine; only the setup failed
    // The user fixes the command in Setup and presses Retry verification: setup passes, the merge follows.
    x.db.repos.update('r1', { setup_command: marker });
    await x.lc.reverify('ov-1');
    await until(async () => (await x.phase()) === 'merged', WAIT, 'merged');
    expect(fs.existsSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', b.id), 'setup.txt'))).toBe(true);
    expect(x.db.batches.get(b.id)?.setup_at).toBeTruthy();
  });

  it('a failing setup at dispatch reopens the bead with the output, removes the worktree and starts no worker', async () => {
    const x = setup();
    x.db.repos.update('r1', { setup_command: failing });
    await expect(x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' })).rejects.toThrow(/the setup command `.*` failed in the worktree of ov-1/);
    expect(await x.status()).toBe('open');
    expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toMatch(/Setup failed in the bead's worktree, so no worker was started:\n\$ node -e .*\nnpx canceled due to missing packages/);
    expect(x.wakes.at(-1)).toMatch(/^ov-1 was not dispatched: the setup command `.*` failed in its worktree\./);
    expect(fs.existsSync(path.join(x.worktreesDir, 'r1', 'ov-1'))).toBe(false);
    expect(x.db.worktrees.get('ov-1')).toBeUndefined(); // no row either: nothing was dispatched
    expect(x.db.sessions.forBead('ov-1')).toEqual([]);
  });

  it('a commit hook that rejects the merge into the batch reopens the bead saying so, with the hook output', async () => {
    const x = setup();
    const hooks = path.join(x.repo.path, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\ntest -f setup.txt || { echo "npx canceled due to missing packages" >&2; exit 1; }\n', { mode: 0o755 });
    x.db.repos.update('r1', { setup_command: marker }); // the setup command leaves setup.txt, the generated dependency the hook needs
    const b = await x.lc.createBatch('r1', 'Hooked');
    // The bead's own worktree gets setup.txt from the setup command at dispatch; removing it from the batch worktree puts that one
    // back in the bare state the hook rejects.
    fs.rmSync(path.join(batchWorktreePath(x.worktreesDir, 'r1', b.id), 'setup.txt'));
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: b.id });
    const wt = x.db.worktrees.get('ov-1')!;
    expect(fs.existsSync(path.join(wt.path, 'setup.txt'))).toBe(true); // the setup command left it there, not the worker
    await commitFileAsync(wt.path, 'x.txt', 'x\n', 'x');
    x.finishTurn(sid);
    await until(async () => (await x.status()) === 'open' && (await x.phase()) === null, WAIT, 'reopened');
    expect((await x.store.show(x.repo.path, 'ov-1'))!.notes).toMatch(/Integration failed: the repository's commit hook rejected the merge of bead\/ov-1: .*npx canceled due to missing packages/s);
    expect(x.wakes.at(-1)).toMatch(/integration into feature\/hooked failed: the repository's commit hook rejected the merge/);
  });
});

describe.concurrent('Lifecycle session end settles once', () => {
  /** The `session:ended` the manager emits for an ended row, built from the row so both deliveries carry the same session. */
  const ended = (x: ReturnType<typeof setup>, id: string, lastText: string | null = null, lastError: string | null = null) => ({ session: x.db.sessions.get(id)!, lastText, lastError, files: [] });

  it('settles a worker session once when its end is delivered twice', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    const end = ended(x, sid, 'Added hello.txt');
    // Two deliveries of the same end with no settlement in between: the guard settles the first and ignores the second.
    x.bus.emit('session:ended', end);
    x.bus.emit('session:ended', end);
    await until(async () => (await x.phase()) === 'review', WAIT, 'verified once');
    await new Promise((r) => setImmediate(r)); // any second settlement would have reached its notice by now
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
    expect(x.db.sessions.get(sid)?.settled_at).toBeTruthy();
  });

  it('settles a critic session once when its end is delivered twice', async () => {
    const x = setup(undefined, 3, { reviewRounds: 1 });
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    const adapter = x.db.sessions.get(sid)!.harness === 'claude' ? x.fake : x.codex;
    adapter.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.1 });
    await until(() => !!x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic' && s.status === 'running'), WAIT, 'critic session');
    const critic = x.db.sessions.forBead('ov-1').find((s) => s.role === 'critic' && s.status === 'running')!;
    x.lc.recordReview('ov-1', { verdict: 'pass', findings: [] });
    // The critic settle path is entered once, whatever the two deliveries: a spy proves the second never reached it.
    const settle = vi.spyOn(x.lc as unknown as { onCriticEnded: (e: unknown) => Promise<void> }, 'onCriticEnded');
    const end = ended(x, critic.id, 'Looks good.');
    x.bus.emit('session:ended', end);
    x.bus.emit('session:ended', end);
    await until(async () => (await x.phase()) === 'review', WAIT, 'reviewed once');
    await new Promise((r) => setImmediate(r));
    expect(settle).toHaveBeenCalledTimes(1);
    settle.mockRestore();
    expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed; reviewed by claude fable']);
    expect(x.db.sessions.get(critic.id)?.settled_at).toBeTruthy();
  });

  it('settles a usage-limit end once when it is delivered twice', async () => {
    const x = setup();
    const tiers = structuredClone(x.db.settings.tiers());
    for (const tier of tiers.tiers) if (tier.name === 'standard') tier.candidates = [{ harness: 'codex', model: 'terra', effort: null, account: null }, { harness: 'claude', model: 'sonnet', effort: null, account: null }];
    x.db.settings.set('tiers', tiers);
    const first = await x.lc.spawnWorker('r1', 'ov-1', { tier: 'standard' });
    const reset = new Date(2099, 8, 20, 12, 18);
    const h = x.sessions.handleOf(first)!;
    x.codex.emit(h, { type: 'usage_limit', resetsAt: reset.toISOString(), message: 'usage limit' });
    x.codex.emit(h, { type: 'error', message: 'exceeded retry limit' });
    await x.codex.end(h);
    await until(() => x.db.sessions.get(first)?.status !== 'running', WAIT, 'session ended');
    const claimed = x.db.sessions.get(first)?.settled_at;
    expect(claimed).toBeTruthy();
    // The end the manager reported (above) is delivered again: only the first settlement may re-dispatch.
    x.bus.emit('session:ended', ended(x, first, null, 'exceeded retry limit'));
    await until(() => x.db.sessions.forBead('ov-1').filter((s) => s.status === 'running').length === 1 && x.db.sessions.forBead('ov-1').length === 2, WAIT, 'usage-limit re-dispatch');
    await new Promise((r) => setImmediate(r));
    expect(x.db.sessions.forBead('ov-1')).toHaveLength(2); // one re-dispatch, not two
    expect(x.notes.filter((n) => n.includes('re-dispatched'))).toHaveLength(1);
    expect(x.notes.some((n) => n.includes('reopened'))).toBe(false); // the second delivery did not settle the old session as a no-commit reopen
    expect(await x.status()).toBe('in_progress');
    expect(x.db.sessions.get(first)?.settled_at).toBe(claimed); // the guard returned before writing a second settlement
  });

  it('settles two different sessions ending at once, each once', async () => {
    const x = setup();
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Second' });
    const a = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const b = await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'a.txt', 'a\n', 'a');
    await commitFileAsync(x.db.worktrees.get('ov-2')!.path, 'b.txt', 'b\n', 'b');
    x.bus.emit('session:ended', ended(x, a, 'a done'));
    x.bus.emit('session:ended', ended(x, b, 'b done'));
    await until(async () => (await x.phase('ov-1')) === 'review' && (await x.phase('ov-2')) === 'review', WAIT, 'both settled');
    await new Promise((r) => setImmediate(r));
    expect([...x.notes].sort()).toEqual([
      'ov-1 is in review; verify command `node -e "process.exit(0)"` passed',
      'ov-2 is in review; verify command `node -e "process.exit(0)"` passed',
    ]);
  });

  it('does not settle a session again when its end is delivered after a restart', async () => {
    const x = setup();
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
    const end = ended(x, sid, 'Added hello.txt');
    x.bus.emit('session:ended', end);
    await until(async () => (await x.phase()) === 'review', WAIT, 'settled before the restart');
    const claimed = x.db.sessions.get(sid)?.settled_at;
    expect(claimed).toBeTruthy();
    // A fresh lifecycle over the same rows, as after a restart: its in-memory set is empty, so only the row's settled_at can stop a second settlement.
    const restartedNotes: string[] = [];
    const restartedBus = new Bus();
    const restarted = new Lifecycle({ db: x.db, store: x.store, sessions: x.sessions, bus: restartedBus, config: { ...loadConfig({}), worktreesDir: x.worktreesDir }, provider: () => new LocalMergeProvider(), notify: async (m) => { restartedNotes.push(m); } });
    expect(restarted).toBeInstanceOf(Lifecycle);
    restartedBus.emit('session:ended', end);
    await new Promise((r) => setImmediate(r));
    expect(restartedNotes).toEqual([]);
    expect(x.db.sessions.get(sid)?.settled_at).toBe(claimed); // the row's settled_at stopped the second settlement before it started
    expect(await x.phase()).toBe('review');
  });

  it('settles once a session that was running at the restart and ends after re-adoption', async () => {
    const x = setup();
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-once-')), 'w.log');
    const child = spawnLines(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { logFile });
    try {
      const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude' });
      await until(() => x.db.sessions.get(sid)?.pid === 4242, WAIT, 'fake pid recorded');
      const pid = child.pid!;
      x.db.sessions.update(sid, { pid, pid_started_at: await processStartTime(pid), log_path: logFile });
      await x.lc.recover(); // adopts the live process: its end has not been settled yet
      expect(x.sessions.isLive(sid)).toBe(true);
      await commitFileAsync(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'add greeting');
      await x.sessions.end(sid); // the re-adopted process ends, one delivery, settled once
      await until(async () => (await x.phase()) === 'review', WAIT, 'settled once');
      await new Promise((r) => setImmediate(r));
      expect(x.notes).toEqual(['ov-1 is in review; verify command `node -e "process.exit(0)"` passed']);
      expect(x.db.sessions.get(sid)?.settled_at).toBeTruthy();
    } finally {
      await killProcess(child.pid!).catch(() => {});
    }
  });
});
