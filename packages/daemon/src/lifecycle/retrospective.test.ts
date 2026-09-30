import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { BatchRetrospective, Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';
import { MemoryTaskStore } from '../beads/memory';
import { LocalMergeProvider } from '../git/provider';
import { mkTmpRepo, copyTmpRepo, commitFile } from '../test/tmpgit';
import { Lifecycle } from './lifecycle';
import { loadConfig } from '../config';
import { beadRetrospective, compactRetrospective, correctionMatch, retrospectiveSummary } from './retrospective';
import os from 'node:os';

const LOG_DIR = path.join(os.tmpdir(), 'overseer-test-sessions'); // the fake adapter never writes there
const shellExit = (code: number) => process.platform === 'win32' ? `exit /b ${code}` : code === 0 ? 'true' : 'false';
const template = mkTmpRepo();

function setup(verify = shellExit(0)) {
  const t = copyTmpRepo(template);
  const db = openDb(':memory:', { batchIdSuffix: () => '' });
  const bus = new Bus();
  const fake = new FakeAdapter();
  const sessions = new SessionManager(db, { claude: fake }, bus, LOG_DIR);
  const store = new MemoryTaskStore();
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: verify, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null }; // no review round: these tests assert the landing signals themselves
  db.repos.insert(repo);
  store.add(repo.path, { id: 'ov-1', title: 'Add greeting', description: 'Write hello.txt' });
  const notes: string[] = [];
  const hints: (string | undefined)[] = [];
  const config = { ...loadConfig({}), worktreesDir: t.worktreesDir, dataDir: path.dirname(t.worktreesDir) };
  const lc = new Lifecycle({ db, store, sessions, bus, config, provider: () => new LocalMergeProvider(), notify: async (m, o) => { notes.push(m); hints.push(o?.hint); } });
  const status = async (id = 'ov-1') => (await store.show(repo.path, id))!.status;
  const finishTurn = (sid: string) => fake.emit(sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n1', cost: 0.25 });
  const retros = () => notes.filter((n) => n.startsWith('Retrospective ready'));
  // Resolves on the first board refresh after which `check` holds; the lifecycle emits one when it has settled a turn or a retry.
  // The 15s cap is deliberately below `until`'s default (45000) and names the wait, so a lifecycle path that stops emitting the
  // event fails fast with that name instead of hanging until the test timeout.
  const settled = (label: string, check: () => boolean | Promise<boolean>) => new Promise<void>((resolve, reject) => {
    let off: () => void = () => {};
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${label}`)); }, 15000);
    off = bus.on('board', () => { void Promise.resolve(check()).then((ok) => { if (!ok) return; clearTimeout(timer); off(); resolve(); }, (err) => { clearTimeout(timer); off(); reject(err); }); });
  });
  const reached = (want: string, id = 'ov-1') => settled(`${id} to reach ${want}`, async () => (await status(id)) === want);
  return { db, store, repo, lc, notes, hints, status, finishTurn, retros, fake, sessions, settled, reached };
}

// Independent repositories, so the tests run concurrently. The file stays in slowTestFiles on purpose: its wall time is
// the real git the tests exist to exercise, not avoidable waiting. One run spawns ~188 `git` processes, and on a loaded
// Windows host a bare `git rev-parse` costs ~207ms (a worktree add+remove+branch cycle ~642ms), so four concurrent tests
// still take ~20s. Cutting that further would mean stubbing git, which would stop testing the landing this file checks.
describe.concurrent('batch retrospective', () => {
  it('collects a rejection, two reopens of different classes, a re-dispatch with instructions, a close and a matching chat message', async () => {
    const x = setup(shellExit(1));
    await x.lc.createBatch('r1', 'Two files');
    // Reopen 1: the worker ends without commits.
    const sid1 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const reopenedWithoutCommits = x.reached('open');
    x.finishTurn(sid1);
    await reopenedWithoutCommits;
    expect(await x.status()).toBe('open');
    // Re-dispatch with instructions; reopen 2: the verify command fails.
    const sid2 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', instructions: 'Commit your work this time.', batchId: 'r1-b1' });
    commitFile(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'hello');
    const reopenedAfterVerification = x.reached('open');
    x.finishTurn(sid2);
    await reopenedAfterVerification;
    expect(await x.status()).toBe('open');
    // The command was wrong; fixed in Setup, Retry verification lands the bead.
    x.db.repos.update('r1', { verify_command: shellExit(0) });
    const reverified = x.reached('closed');
    await x.lc.reverify('ov-1');
    await reverified;
    expect(await x.status()).toBe('closed');
    // A second bead the user closes as won't do, and two chat messages of which one reads as a correction.
    x.store.add(x.repo.path, { id: 'ov-2', title: 'Add bye.txt', labels: ['overseer:batch:r1-b1'] });
    await x.lc.closeBead('ov-2', 'Not needed after all.');
    x.db.chat.insert({ role: 'user', kind: 'message', text: 'Why is it still working on the greeting?' });
    x.db.chat.insert({ role: 'user', kind: 'message', text: 'Please also add tests.' });
    x.db.chat.insert({ role: 'assistant', kind: 'message', text: "I don't know why." }); // not the user's
    await x.lc.requestBatchReview('r1', 'r1-b1', 'first pass');
    await x.lc.rejectBatch('r1-b1', 'The greeting is in the wrong file.');

    const r = await x.lc.retrospective('r1-b1');
    expect(r).toMatchObject({ batch_id: 'r1-b1', title: 'Two files', status: 'open', ended_at: null });
    expect(r.signals.rejections).toMatchObject([{ note: 'The greeting is in the wrong file.' }]);
    expect(r.signals.reopens.map((s) => [s.bead_id, s.reason])).toEqual([['ov-1', 'no_commits'], ['ov-1', 'verify_failed']]);
    expect(r.signals.reopens[0]!.note).toBe('no output');
    expect(r.signals.redispatches).toMatchObject([{ bead_id: 'ov-1', instructions: 'Commit your work this time.' }]);
    expect(r.signals.closed).toMatchObject([{ bead_id: 'ov-2', note: 'Not needed after all.' }]);
    expect(r.signals.corrections).toMatchObject([{ text: 'Why is it still working on the greeting?', matched: 'why' }]);
    expect(r.counts).toMatchObject({ beads_total: 2, reopens: 2, redispatches: 1, signals: 6, worker_cost: 0.5 });
    expect(r.counts.wall_clock_ms).toBeGreaterThanOrEqual(0);
    for (const s of [...r.signals.rejections, ...r.signals.reopens, ...r.signals.redispatches, ...r.signals.closed, ...r.signals.corrections]) expect(s.ts).toMatch(/^\d{4}-/);

    // The rejection sent the notice: two lines, counts by class, and the tool to call travels as the hint.
    expect(x.retros()).toEqual([`Retrospective ready for batch r1-b1 (6 signals): rejected, 2 beads, 0 min, worker cost $0.50.\n1 rejection, 2 reopens, 1 re-dispatch, 1 bead closed as won't do, 1 correction.`]);
    expect(x.hints[x.notes.indexOf(x.retros()[0]!)]).toMatch(/batch_retrospective/);

    // The merge sends it again, with the batch's end in the record.
    await x.lc.requestBatchReview('r1', 'r1-b1', 'second pass');
    await x.lc.mergeBatch('r1-b1');
    expect(x.retros()).toHaveLength(2);
    expect(x.retros()[1]).toMatch(/^Retrospective ready for batch r1-b1 \(6 signals\): merged,/);
    const merged = await x.lc.retrospective('r1-b1');
    expect(merged.status).toBe('merged');
    expect(merged.ended_at).toBe(x.db.batches.get('r1-b1')!.merged_at);
  });

  it('sends the notice on abandon, and not for a batch with zero signals', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Clean run');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    commitFile(x.db.worktrees.get('ov-1')!.path, 'hello.txt', 'hi\n', 'hello');
    const landed = x.reached('closed');
    x.finishTurn(sid);
    await landed;
    expect(await x.status()).toBe('closed');
    await x.lc.requestBatchReview('r1', 'r1-b1', 'done');
    await x.lc.mergeBatch('r1-b1');
    expect(x.retros()).toEqual([]);
    expect((await x.lc.retrospective('r1-b1')).counts.signals).toBe(0);

    x.store.add(x.repo.path, { id: 'ov-2', title: 'Second' });
    await x.lc.createBatch('r1', 'Given up');
    const sid2 = await x.lc.spawnWorker('r1', 'ov-2', { harness: 'claude', batchId: 'r1-b2' });
    const reopened = x.reached('open', 'ov-2');
    x.finishTurn(sid2);
    await reopened;
    expect(await x.status('ov-2')).toBe('open');
    await x.lc.abandonBatch('r1-b2');
    expect(x.retros()).toEqual([`Retrospective ready for batch r1-b2 (1 signal): abandoned, 1 bead, 0 min, worker cost $0.25.\n1 reopen.`]);
  });

  it('never sends the notice for a "Lessons from" batch, so the loop does not feed itself', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Lessons from r1-b7');
    const sid = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    const reopened = x.reached('open');
    x.finishTurn(sid);
    await reopened;
    expect(await x.status()).toBe('open');
    await x.lc.abandonBatch('r1-b1');
    expect((await x.lc.retrospective('r1-b1')).counts.signals).toBe(1); // the record exists; only the notice is withheld
    expect(x.retros()).toEqual([]);
  });

  it('records a crash signal for each classified crash, listed under crashes', async () => {
    const x = setup();
    await x.lc.createBatch('r1', 'Flaky');
    const sid1 = await x.lc.spawnWorker('r1', 'ov-1', { harness: 'claude', batchId: 'r1-b1' });
    x.fake.emit(x.sessions.handleOf(sid1)!, { type: 'error', message: 'event stream failed: socket hang up' });
    const retried = x.settled('the transient retry session', () => x.db.sessions.forBead('ov-1').length === 2);
    x.fake.emit(x.sessions.handleOf(sid1)!, { type: 'turn_end', nativeSessionId: '' });
    await retried;
    const sid2 = x.db.sessions.forBead('ov-1')[1]!.id;
    x.fake.emit(x.sessions.handleOf(sid2)!, { type: 'error', message: 'event stream failed: socket hang up' });
    const reopened = x.reached('open');
    x.fake.emit(x.sessions.handleOf(sid2)!, { type: 'turn_end', nativeSessionId: '' });
    await reopened;
    expect(await x.status()).toBe('open');

    const r = await x.lc.retrospective('r1-b1');
    expect(r.crashes).toMatchObject([
      { bead_id: 'ov-1', crash_class: 'transient', reason: 'event stream failed: socket hang up' },
      { bead_id: 'ov-1', crash_class: 'transient', reason: 'event stream failed: socket hang up' },
    ]);
  });

  it('matches corrections by plain keyword, case-insensitively', () => {
    expect(correctionMatch("That's not what I asked")).toBe('not what');
    expect(correctionMatch('DON\'T touch the schema')).toBe("don't");
    expect(correctionMatch('Use the auth lib instead')).toBe('instead');
    expect(correctionMatch('Looks good, merge it')).toBeNull();
  });

  it('summary reads singular and plural counts', () => {
    const base = { batch_id: 'b', title: 't', status: 'merged' as const, created_at: '', ended_at: null, signals: { rejections: [], reopens: [], redispatches: [], closed: [], corrections: [{ text: 'why', matched: 'why', ts: '' }] }, crashes: [], counts: { beads_total: 1, reopens: 0, redispatches: 0, signals: 1, worker_cost: 0, wall_clock_ms: 90_000 } };
    expect(retrospectiveSummary(base, 'merged')).toBe('Retrospective ready for batch b (1 signal): merged, 1 bead, 2 min, worker cost $0.00.\n1 correction.');
  });
});

describe('the compact retrospective result', () => {
  // A fixture where every text is longer than the limit it is measured against, so a cut is visible against the raw text.
  const build = (): BatchRetrospective => ({
    batch_id: 'r1-b1', title: 'Two files', status: 'merged', created_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:05:00.000Z',
    signals: {
      rejections: [{ note: 'r'.repeat(500), ts: '2026-01-01T00:00:01.000Z' }, { note: 'short', ts: '2026-01-01T00:00:02.000Z' }],
      reopens: [{ bead_id: 'ov-1', reason: 'no_commits', note: 'n'.repeat(400), ts: '2026-01-01T00:00:03.000Z' }],
      redispatches: [
        { bead_id: 'ov-1', instructions: 'i'.repeat(400), ts: '2026-01-01T00:00:04.000Z' },
        { bead_id: 'ov-1', instructions: 'again', ts: '2026-01-01T00:00:05.000Z' },
        { bead_id: 'ov-2', instructions: null, ts: '2026-01-01T00:00:06.000Z' },
      ],
      closed: [{ bead_id: 'ov-2', note: 'c'.repeat(400), ts: '2026-01-01T00:00:07.000Z' }, { bead_id: 'ov-3', note: null, ts: '2026-01-01T00:00:08.000Z' }],
      corrections: [{ text: 'k'.repeat(500), matched: 'why', ts: '2026-01-01T00:00:09.000Z' }],
    },
    crashes: [{ bead_id: 'ov-1', crash_class: 'task', reason: 'z'.repeat(400), ts: '2026-01-01T00:00:10.000Z' }],
    counts: { beads_total: 3, reopens: 1, redispatches: 3, signals: 6, worker_cost: 1.5, wall_clock_ms: 300_000 },
  });

  it('cuts long rejection and correction text to 400 characters with a truncated flag, and leaves short text unflagged', () => {
    const c = compactRetrospective(build());
    expect(c.signals.rejections[0]).toEqual({ note: 'r'.repeat(400), truncated: true, ts: '2026-01-01T00:00:01.000Z' });
    expect(c.signals.rejections[1]).toEqual({ note: 'short', truncated: false, ts: '2026-01-01T00:00:02.000Z' });
    expect(c.signals.corrections[0]).toEqual({ text: 'k'.repeat(400), truncated: true, matched: 'why', ts: '2026-01-01T00:00:09.000Z' });
  });

  it('cuts reopen, closed and crash text to 300 characters and groups re-dispatches per bead with each instruction cut to 300', () => {
    const c = compactRetrospective(build());
    expect(c.signals.reopens[0]!.note).toBe('n'.repeat(300));
    expect(c.signals.closed[0]!.note).toBe('c'.repeat(300));
    expect(c.signals.closed[1]!.note).toBeNull();
    expect(c.crashes[0]!.reason).toBe('z'.repeat(300));
    expect(c.signals.redispatches).toEqual([
      { bead_id: 'ov-1', count: 2, instructions: ['i'.repeat(300), 'again'] },
      { bead_id: 'ov-2', count: 1, instructions: [''] },
    ]);
  });

  it('keeps the counts of the full record', () => {
    expect(compactRetrospective(build()).counts).toEqual(build().counts);
  });

  it('returns one bead\'s signals in full, uncut, when asked for that bead', () => {
    const b = beadRetrospective(build(), 'ov-1');
    expect(b.signals.reopens.map((s) => s.note)).toEqual(['n'.repeat(400)]);
    expect(b.signals.redispatches.map((s) => s.instructions)).toEqual(['i'.repeat(400), 'again']);
    expect(b.crashes.map((c) => c.reason)).toEqual(['z'.repeat(400)]);
    expect(b.signals.closed).toEqual([]);
    expect(b.signals.rejections).toEqual([]);
    expect(b.signals.corrections).toEqual([]);
    expect(b.counts).toEqual(build().counts);
  });
});
