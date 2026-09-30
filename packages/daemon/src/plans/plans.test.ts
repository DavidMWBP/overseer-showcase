import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlanStep, Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';
import { MemoryTaskStore } from '../beads/memory';
import { LocalMergeProvider } from '../git/provider';
import { Lifecycle } from '../lifecycle/lifecycle';
import { loadConfig } from '../config';
import { mkTmpRepo, sh } from '../test/tmpgit';
import { Plans, PlanConflictError, PlanError } from './plans';

const LOG_DIR = path.join(os.tmpdir(), 'overseer-test-sessions');

const dataDirs: string[] = [];
afterAll(() => { for (const d of dataDirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const t = mkTmpRepo();
  const db = openDb(':memory:', { batchIdSuffix: () => '' });
  const bus = new Bus();
  const sessions = new SessionManager(db, { claude: new FakeAdapter() }, bus, LOG_DIR);
  const store = new MemoryTaskStore();
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 0, model_filter: null };
  db.repos.insert(repo);
  const notes: { text: string; wake: boolean; hint?: string }[] = [];
  const pushes: { title: string; body: string; url: string }[] = [];
  const notify = async (text: string, o?: { wake?: boolean; hint?: string }) => { notes.push({ text, wake: !!o?.wake, ...(o?.hint ? { hint: o.hint } : {}) }); };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-data-'));
  dataDirs.push(dataDir);
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), worktreesDir: t.worktreesDir };
  const lifecycle = new Lifecycle({ db, store, sessions, bus, config, provider: () => new LocalMergeProvider(), notify });
  const planEvents: number[] = [];
  bus.on('plans', () => planEvents.push(1));
  const plans = new Plans({ db, store, lifecycle, bus, notify, push: { notify: (m: { title: string; body: string; url: string }) => { pushes.push(m); return Promise.resolve(); } } as never });
  const branches = () => sh(repo.path, ['branch', '--list', 'feature/*']);
  return { db, store, repo, plans, notes, pushes, planEvents, branches, dataDir };
}

const steps: PlanStep[] = [
  { title: 'Accounts table', description: 'Add the table', dependsOn: [] },
  { title: 'Login flow', description: 'OAuth from Setup', dependsOn: [0] },
];

describe('Plans', () => {
  it('proposes a draft without touching git or bd', async () => {
    const x = setup();
    const p = await x.plans.propose('r1', 'Accounts', steps);
    expect(p).toMatchObject({ id: 'r1-p1', repo_id: 'r1', title: 'Accounts', steps, status: 'draft', batch_id: null, revision: 1 });
    expect(x.db.plans.get('r1-p1')).toMatchObject({ status: 'draft' });
    expect(x.db.batches.all()).toEqual([]);
    expect(x.branches()).toBe('');
    expect(await x.store.list(x.repo.path)).toEqual([]);
    expect(x.planEvents.length).toBe(1);
    expect(x.notes).toEqual([{ text: 'Accounts: plan ready for review (2 steps)', wake: false, hint: expect.stringContaining('Stop here') }]);
    expect(x.pushes).toEqual([{ title: 'r1: plan ready for review', body: 'Accounts', url: '#plan/r1-p1' }]);
  });

  it('refuses an unknown repo or an invalid plan and stores nothing', async () => {
    const x = setup();
    await expect(x.plans.propose('nope', 'Accounts', steps)).rejects.toThrow(PlanError);
    await expect(x.plans.propose('r1', 'Accounts', [{ title: '', description: '', dependsOn: [] }])).rejects.toThrow('Step 1 needs a title.');
    expect(x.db.plans.drafts()).toEqual([]);
  });

  it('saves at the current revision and refuses a stale one', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    const saved = x.plans.save('r1-p1', { title: 'Accounts v2', steps: [steps[0]!], revision: 1 });
    expect(saved).toMatchObject({ title: 'Accounts v2', steps: [steps[0]], revision: 2 });
    expect(() => x.plans.save('r1-p1', { title: 'Stale', steps, revision: 1 })).toThrow(PlanConflictError);
    expect(() => x.plans.save('r1-p1', { title: '', steps, revision: 2 })).toThrow('The plan needs a title.');
    expect(x.db.plans.get('r1-p1')).toMatchObject({ title: 'Accounts v2', revision: 2 });
  });

  it('lists every plan of every status, newest first, so a discarded or approved one stays reachable', async () => {
    const x = setup();
    await x.plans.propose('r1', 'First', steps); // r1-p1, discarded below
    await x.plans.propose('r1', 'Second', steps); // r1-p2, approved below
    await x.plans.propose('r1', 'Third', steps); // r1-p3, stays a draft
    x.plans.discard('r1-p1');
    await x.plans.approve('r1-p2', 1);
    expect(x.plans.all().map((p) => [p.id, p.status])).toEqual([['r1-p3', 'draft'], ['r1-p2', 'approved'], ['r1-p1', 'discarded']]);
    expect(x.plans.drafts().map((p) => p.id)).toEqual(['r1-p3']);
  });

  it('approves: the batch first, then beads in dependency order, labelled and wired', async () => {
    const x = setup();
    // Step 1 depends on step 3, which is listed below it: creation must follow the dependency, not the list.
    await x.plans.propose('r1', 'Accounts', [
      { title: 'Login flow', description: 'OAuth', dependsOn: [2] },
      { title: 'Docs', description: '', dependsOn: [] },
      { title: 'Accounts table', description: 'Table', dependsOn: [] },
    ]);
    const approved = await x.plans.approve('r1-p1', 1);
    expect(approved).toMatchObject({ status: 'approved', batch_id: 'r1-b1' });
    expect(x.db.batches.get('r1-b1')).toMatchObject({ title: 'Accounts', status: 'open', origin_chat_id: null });
    const beads = await x.store.list(x.repo.path);
    const byTitle = Object.fromEntries(beads.map((b) => [b.title, b]));
    for (const b of beads) expect(b.labels).toContain('overseer:batch:r1-b1');
    expect(await x.store.blocked(x.repo.path)).toEqual([{ id: byTitle['Login flow']!.id, blocked_by: [byTitle['Accounts table']!.id] }]);
    const ids = ['Login flow', 'Docs', 'Accounts table'].map((t) => byTitle[t]!.id);
    expect(x.notes.at(-1)).toEqual({ text: `Accounts: plan approved by the user; batch r1-b1 created with beads ${ids.join(', ')}`, wake: true, hint: expect.stringContaining('spawn_worker') });
  });

  it('approves in a local-merge repo whose origin has commits the local base lacks: the notice carries the warning with the count', async () => {
    const x = setup();
    const bare = path.join(path.dirname(x.repo.path), 'origin.git');
    sh(x.repo.path, ['clone', '-q', '--bare', x.repo.path, bare]);
    sh(x.repo.path, ['remote', 'add', 'origin', bare]);
    const other = path.join(path.dirname(x.repo.path), 'other');
    sh(x.repo.path, ['clone', '-q', bare, other]);
    fs.writeFileSync(path.join(other, 'remote.txt'), 'r\n');
    sh(other, ['add', '.']);
    sh(other, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'remote']);
    sh(other, ['push', '-q', 'origin', 'main']);
    const localMain = sh(x.repo.path, ['rev-parse', 'main']);
    await x.plans.propose('r1', 'Accounts', steps);
    await x.plans.approve('r1-p1', 1);
    expect(sh(x.repo.path, ['rev-parse', 'feature/accounts'])).toBe(localMain);
    expect(x.notes.at(-1)?.text).toMatch(/^Accounts: plan approved by the user; batch r1-b1 created with beads .+\norigin\/main has 1 commit that the local main lacks; the branch was cut from the local main/);
  });

  it('refuses to approve at a stale revision and creates nothing', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    x.plans.save('r1-p1', { title: 'Accounts', steps: [steps[0]!], revision: 1 });
    await expect(x.plans.approve('r1-p1', 1)).rejects.toThrow(PlanConflictError);
    expect(x.db.batches.all()).toEqual([]);
    expect(x.branches()).toBe('');
  });

  it('rolls back when a bd write fails part-way and keeps the draft', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    x.store.failCreate = 'Login flow';
    await expect(x.plans.approve('r1-p1', 1)).rejects.toThrow(/Login flow/);
    expect(x.db.plans.get('r1-p1')).toMatchObject({ status: 'draft', batch_id: null, revision: 1 });
    expect(x.db.batches.all()).toEqual([]);
    expect(x.branches()).toBe('');
    const made = await x.store.list(x.repo.path);
    expect(made.map((b) => [b.title, b.status])).toEqual([['Accounts table', 'closed']]);
    expect(x.notes.filter((n) => n.wake)).toEqual([]);
    x.store.failCreate = null;
    await expect(x.plans.approve('r1-p1', 1)).resolves.toMatchObject({ status: 'approved' }); // the user can try again
  });

  it('says so when the rollback of a failed approval also fails', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    x.store.failCreate = 'Login flow';
    const originalClose = x.store.close.bind(x.store);
    x.store.close = () => Promise.reject(new Error('bd close boom'));
    try {
      await expect(x.plans.approve('r1-p1', 1)).rejects.toThrow(/Login flow.*also failed.*bd close boom/s);
    } finally {
      x.store.close = originalClose;
    }
    expect(x.db.plans.get('r1-p1')).toMatchObject({ status: 'draft', batch_id: null, revision: 1 });
  });

  it('refuses a second approval while the first is running', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    const first = x.plans.approve('r1-p1', 1);
    await expect(x.plans.approve('r1-p1', 1)).rejects.toThrow(PlanConflictError);
    await first;
    expect(x.db.batches.all()).toHaveLength(1);
  });

  it('refuses a save while an approval is running, keeping the original title and steps', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    const first = x.plans.approve('r1-p1', 1);
    expect(() => x.plans.save('r1-p1', { title: 'Changed', steps: [steps[0]!], revision: 1 })).toThrow(PlanConflictError);
    await first;
    expect(x.db.plans.get('r1-p1')).toMatchObject({ status: 'approved', title: 'Accounts', steps });
  });

  it('refuses a discard while an approval is running, keeping the original title and steps', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    const first = x.plans.approve('r1-p1', 1);
    expect(() => x.plans.discard('r1-p1')).toThrow(PlanConflictError);
    await first;
    expect(x.db.plans.get('r1-p1')).toMatchObject({ status: 'approved', title: 'Accounts', steps });
  });

  it('discards a draft and refuses to act on a plan that is no longer one', async () => {
    const x = setup();
    await x.plans.propose('r1', 'Accounts', steps);
    expect(x.plans.discard('r1-p1')).toMatchObject({ status: 'discarded' });
    expect(() => x.plans.discard('r1-p1')).toThrow(PlanConflictError);
    await expect(x.plans.approve('r1-p1', 1)).rejects.toThrow(PlanConflictError);
    expect(() => x.plans.save('r1-p1', { title: 'x', steps, revision: 1 })).toThrow(PlanConflictError);
    expect(x.db.batches.all()).toEqual([]);
    expect(() => x.plans.get('nope')).toThrow(PlanError);
  });
});
