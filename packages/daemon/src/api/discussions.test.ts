import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HarnessName, TierSettings } from '@overseer/shared';
import { openDb, type Db } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import type { SessionHandle } from '../harness/types';
import { SessionManager } from '../sessions/manager';
import { loadConfig, type Config } from '../config';
import { Discussions } from '../discussions/discussions';
import { MemoryTaskStore } from '../beads/memory';
import { ActionJobs } from './jobs';
import { registerRest } from './rest';
import type { AppDeps } from '../app';
import { until } from '../test/until';
import { mkTmpRepo, sh, type TmpRepo } from '../test/tmpgit';

const THREE_STANDARD: TierSettings = {
  tiers: [{ name: 'standard', candidates: [
    { harness: 'claude', model: 'sonnet', effort: null },
    { harness: 'codex', model: 'gpt-5.6-terra', effort: null },
    { harness: 'opencode', model: 'deepseek/deepseek-flash', effort: null },
  ] }],
  denyModels: [],
};

const HARNESSES: HarnessName[] = ['claude', 'codex', 'opencode'];

interface Ctx { app: FastifyInstance; db: Db; bus: Bus; discussions: Discussions; config: Config; dataDir: string; sessions: SessionManager; adapters: Record<HarnessName, FakeAdapter> }

async function setup(tiers: TierSettings = THREE_STANDARD): Promise<Ctx> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-disc-rest-'));
  expect(path.resolve(dataDir)).not.toBe(path.resolve(loadConfig({}).dataDir));
  const db = openDb(':memory:');
  const bus = new Bus();
  const adapters: Record<HarnessName, FakeAdapter> = { claude: new FakeAdapter('claude'), codex: new FakeAdapter('codex'), opencode: new FakeAdapter('opencode') };
  const sessions = new SessionManager(db, adapters, bus, path.join(dataDir, 'sessions'));
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: path.join(dataDir, 'worktrees') };
  db.settings.set('tiers', tiers);
  const discussions = new Discussions({ db, sessions, bus, config });
  const app = Fastify({ logger: false });
  // A minimal dependency set: the board route subscribes to `bus` and reads `store`/`jobs` at registration, and every
  // other handler's dependency is never reached by these tests.
  registerRest(app, { db, config, bus, discussions, store: new MemoryTaskStore(), jobs: new ActionJobs(bus) } as unknown as AppDeps);
  await app.ready();
  return { app, db, bus, discussions, config, dataDir, sessions, adapters };
}

const post = (app: FastifyInstance, url: string, body?: object) => app.inject({ method: 'POST', url, payload: body });
const get = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url });
const png = (name: string, data = Buffer.from('image bytes')) => ({ name, mime: 'image/png', data: data.toString('base64') });

describe('discussions REST', () => {
  let x: Ctx;
  beforeEach(async () => { x = await setup(); });
  afterEach(async () => {
    await x.app.close();
    x.db.sql.close();
    fs.rmSync(x.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('creates a discussion with the three default participants and answers its detail', async () => {
    const pings: string[] = [];
    x.bus.on('discussion', (d) => pings.push(d.id));
    const r = await post(x.app, '/api/discussions', { question: 'Which storage engine?' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ question: 'Which storage engine?', repo_id: null, status: 'running', cost_cap: 5, synthesis: null, cost: 0 });
    expect(body.participants.map((p: { harness: string }) => p.harness).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(body.turns).toEqual([]);
    expect(pings).toEqual([body.id]);
  });

  it('stores a cost cap the request names, and refuses a non-positive one', async () => {
    const created = await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude'], cost_cap: 12.5 });
    expect(created.statusCode).toBe(200);
    expect(created.json().cost_cap).toBe(12.5);
    const zero = await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude'], cost_cap: 0 });
    expect(zero.statusCode).toBe(400);
  });

  it('lists discussions and returns one by id, with a 404 for an unknown id', async () => {
    const created = (await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude'] })).json();
    const list = await get(x.app, '/api/discussions');
    expect(list.statusCode).toBe(200);
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([created.id]);
    expect((await get(x.app, `/api/discussions/${created.id}`)).json().id).toBe(created.id);
    expect((await get(x.app, '/api/discussions/nope')).statusCode).toBe(404);
  });

  it('stores and serves question attachments while keeping stored paths private', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 255]);
    const createdResponse = await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude'], attachments: [png('screen.png', bytes)] });
    expect(createdResponse.statusCode).toBe(200);
    const created = createdResponse.json();
    const metadata = [{ name: 'screen.png', mime: 'image/png', size: bytes.length }];
    expect(created.attachments).toEqual(metadata);
    expect(created.attachments[0]).not.toHaveProperty('path');
    expect((await get(x.app, `/api/discussions/${created.id}`)).json().attachments).toEqual(metadata);
    expect((await get(x.app, '/api/discussions')).json()[0].attachments).toEqual(metadata);

    const storedPath = path.join(x.config.orchestratorDir, 'attachments', `discussion-${created.id}-0.png`);
    expect(fs.readFileSync(storedPath)).toEqual(bytes);
    const served = await get(x.app, `/api/discussions/${created.id}/attachments/0`);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(Buffer.from(served.rawPayload)).toEqual(bytes);
    expect((await get(x.app, `/api/discussions/${created.id}/attachments/1`)).statusCode).toBe(404);
    expect((await get(x.app, '/api/discussions/nope/attachments/0')).statusCode).toBe(404);
  });

  it('rejects five question attachments', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', attachments: [0, 1, 2, 3, 4].map((i) => png(`${i}.png`)) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at most 4 attachments/);
  });

  it('rejects a question attachment with a wrong mime type', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', attachments: [{ name: 'note.txt', mime: 'text/plain', data: 'QQ==' }] });
    expect(r.statusCode).toBe(400);
  });

  it('rejects question attachments larger than 8 MB after decoding', async () => {
    const data = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
    const r = await post(x.app, '/api/discussions', { question: 'Q', attachments: [{ name: 'large.png', mime: 'image/png', data }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('attachment large.png exceeds 8 MB');
  });

  it('rejects a question attachment data URL prefix', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', attachments: [{ name: 'screen.png', mime: 'image/png', data: 'data:image/png;base64,QQ==' }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('attachment screen.png data must be raw base64 without a data URL prefix');
  });

  it('stops a discussion and ends its sessions', async () => {
    const created = (await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude', 'codex'] })).json();
    await until(() => x.db.sessions.forDiscussion(created.id).length === 2, 10_000, 'two participants');
    const r = await post(x.app, `/api/discussions/${created.id}/stop`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'stopped', stop_reason: 'stopped by the user' });
    expect(x.db.sessions.forDiscussion(created.id).every((s) => s.status === 'ended')).toBe(true);
  });

  it('stops mid-round at once, with no further round and no synthesis', async () => {
    const created = (await post(x.app, '/api/discussions', { question: 'Q' })).json();
    await until(() => x.db.sessions.forDiscussion(created.id).length === 3, 10_000, 'three participants');
    const sessionOf = (harness: HarnessName) => x.db.sessions.forDiscussion(created.id).find((s) => s.harness === harness && s.discussion_kind !== 'synthesis')!;
    const handles = Object.fromEntries(HARNESSES.map((h) => [h, x.sessions.handleOf(sessionOf(h).id)!])) as Record<HarnessName, SessionHandle>;
    const answer = (harness: HarnessName, text: string) => {
      x.adapters[harness].emit(handles[harness], { type: 'assistant_text', text });
      x.adapters[harness].emit(handles[harness], { type: 'turn_end', nativeSessionId: `n-${harness}` });
    };
    for (const h of HARNESSES) answer(h, `${h} one`);
    await until(() => x.db.discussions.turns(created.id).length === 3, 10_000, 'round 1');
    await until(() => x.adapters.claude.sent(handles.claude).length === 2, 10_000, 'round 2 prompts');
    answer('claude', 'claude two\nChanged: yes');
    await until(() => x.db.discussions.turns(created.id).length === 4, 10_000, 'claude round 2');

    const r = await post(x.app, `/api/discussions/${created.id}/stop`);
    expect(r.statusCode).toBe(200);
    const after = r.json();
    expect(after).toMatchObject({ status: 'stopped', stop_reason: 'stopped by the user', synthesis: null });
    expect(after.turns).toHaveLength(4);
    expect(x.adapters.codex.sent(handles.codex)).toHaveLength(2); // never prompted for round 3
    expect(x.db.sessions.forDiscussion(created.id).some((s) => s.discussion_kind === 'synthesis')).toBe(false);
  });

  it('answers 404 stopping an unknown discussion', async () => {
    expect((await post(x.app, '/api/discussions/nope/stop')).statusCode).toBe(404);
  });

  it('refuses an empty question with a 400', async () => {
    const r = await post(x.app, '/api/discussions', { question: '' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/question must not be empty/);
  });

  it('refuses zero participants with a 400', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', participants: [] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at least one participant/);
  });

  it('refuses four participants with a 400', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude', 'codex', 'opencode', 'claude'] });
    expect(r.statusCode).toBe(400);
  });

  it('refuses a duplicate harness with a 400', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', participants: ['claude', 'claude'] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/listed twice/);
  });

  it('refuses an unknown repo with a 400', async () => {
    const r = await post(x.app, '/api/discussions', { question: 'Q', repo_id: 'nope' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/repo nope not found/);
  });

  it('refuses a harness with no standard candidate with a 400', async () => {
    const only = await setup({ tiers: [{ name: 'standard', candidates: [{ harness: 'claude', model: 'sonnet', effort: null }] }], denyModels: [] });
    try {
      const r = await post(only.app, '/api/discussions', { question: 'Q', participants: ['codex'] });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/no standard-tier model is configured for codex/);
    } finally {
      await only.app.close();
      only.db.sql.close();
      fs.rmSync(only.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

describe('discussions REST: repository removal', () => {
  let t: TmpRepo;
  let x: Ctx & { adapters: Record<HarnessName, FakeAdapter>; sessions: SessionManager };
  beforeEach(async () => {
    t = mkTmpRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-disc-rm-'));
    const db = openDb(':memory:');
    const bus = new Bus();
    const adapters: Record<HarnessName, FakeAdapter> = { claude: new FakeAdapter('claude'), codex: new FakeAdapter('codex'), opencode: new FakeAdapter('opencode') };
    const sessions = new SessionManager(db, adapters, bus, path.join(dataDir, 'sessions'));
    const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: t.worktreesDir };
    db.settings.set('tiers', THREE_STANDARD);
    db.repos.insert({ id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0 });
    const discussions = new Discussions({ db, sessions, bus, config });
    const app = Fastify({ logger: false });
    registerRest(app, { db, config, bus, discussions, sessions, store: new MemoryTaskStore(), jobs: new ActionJobs(bus), orchestrator: { systemMessage: async () => undefined } } as unknown as AppDeps);
    await app.ready();
    x = { app, db, bus, discussions, config, dataDir, adapters, sessions };
  });
  afterEach(async () => {
    await x.app.close();
    x.db.sql.close();
    for (const dir of [x.dataDir, t.root]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const answer = (id: string, harness: HarnessName, text: string, cost: number) => {
    const s = x.db.sessions.forDiscussion(id).find((r) => r.harness === harness)!;
    const h = x.sessions.handleOf(s.id)!;
    x.adapters[harness].emit(h, { type: 'assistant_text', text });
    x.adapters[harness].emit(h, { type: 'turn_end', nativeSessionId: `n-${harness}`, cost });
  };

  it('keeps a finished discussion\'s participants and cost in its detail after the repository is removed', async () => {
    const created = (await post(x.app, '/api/discussions', { question: 'Q', repo_id: 'r1', participants: ['claude', 'codex'] })).json();
    answer(created.id, 'claude', 'Postgres.', 0.25);
    answer(created.id, 'codex', 'SQLite.', 0.5);
    await until(() => x.db.discussions.turns(created.id).length === 2, 10_000, 'two turns');
    await post(x.app, `/api/discussions/${created.id}/stop`);
    const before = (await get(x.app, `/api/discussions/${created.id}`)).json();
    expect(before.cost).toBeCloseTo(0.75);

    const r = await x.app.inject({ method: 'DELETE', url: '/api/repos/r1' });
    expect(r.statusCode).toBe(200);
    expect(x.db.sessions.forDiscussion(created.id)).toEqual([]); // the rows went with the repository
    const after = (await get(x.app, `/api/discussions/${created.id}`)).json();
    expect(after.status).toBe('stopped');
    expect(after.stop_reason).toBe('stopped by the user'); // an ended discussion keeps its own outcome
    expect(after.turns).toHaveLength(2);
    expect(after.participants.map((p: { harness: string }) => p.harness).sort()).toEqual(['claude', 'codex']);
    expect(after.participants.find((p: { harness: string }) => p.harness === 'codex').cost).toBeCloseTo(0.5);
    expect(after.cost).toBeCloseTo(0.75);
    expect((await get(x.app, '/api/discussions')).json()[0].cost).toBeCloseTo(0.75);
  });

  it('keeps an unanswered participant and the others\' cost in the detail after the repository is removed', async () => {
    const created = (await post(x.app, '/api/discussions', { question: 'Q', repo_id: 'r1', participants: ['claude', 'codex'] })).json();
    answer(created.id, 'claude', 'Postgres.', 0.25);
    await until(() => x.db.discussions.turns(created.id).length === 1, 10_000, 'claude answered');
    // codex never answers: without a snapshot its session row would go with the repository and it would vanish from the detail.
    const r = await x.app.inject({ method: 'DELETE', url: '/api/repos/r1' });
    expect(r.statusCode).toBe(200);
    expect(x.db.sessions.forDiscussion(created.id)).toEqual([]);
    const after = (await get(x.app, `/api/discussions/${created.id}`)).json();
    expect(after.status).toBe('stopped');
    expect(after.stop_reason).toBe('repository removed');
    expect(after.participants.map((p: { harness: string }) => p.harness).sort()).toEqual(['claude', 'codex']);
    const byHarness = Object.fromEntries(after.participants.map((p: { harness: string }) => [p.harness, p]));
    expect(byHarness.claude.cost).toBeCloseTo(0.25);
    expect(byHarness.codex).toMatchObject({ status: 'ended', cost: 0 });
    expect(after.cost).toBeCloseTo(0.25);
    expect((await get(x.app, '/api/discussions')).json()[0].cost).toBeCloseTo(0.25);
  });

  it('stops a running discussion with a failed participant, removing its worktrees, before the repository goes', async () => {
    const created = (await post(x.app, '/api/discussions', { question: 'Q', repo_id: 'r1', participants: ['claude', 'codex'] })).json();
    const codex = x.db.sessions.forDiscussion(created.id).find((s) => s.harness === 'codex')!;
    const claude = x.db.sessions.forDiscussion(created.id).find((s) => s.harness === 'claude')!;
    expect(x.sessions.isLive(claude.id)).toBe(true);
    const h = x.sessions.handleOf(codex.id)!;
    x.adapters.codex.emit(h, { type: 'error', message: 'codex exited with code 1' });
    x.adapters.codex.emit(h, { type: 'turn_end', nativeSessionId: 'n' });
    await until(() => x.db.sessions.get(codex.id)?.status === 'failed', 10_000, 'codex failed');
    const root = path.join(t.worktreesDir, 'r1', `disc-${created.id}`);
    expect(fs.readdirSync(root).sort()).toEqual(['claude', 'codex']);

    const r = await x.app.inject({ method: 'DELETE', url: '/api/repos/r1' });
    expect(r.statusCode).toBe(200);
    const row = x.db.discussions.get(created.id)!;
    expect(row.status).toBe('stopped');
    expect(row.stop_reason).toBe('repository removed');
    expect(fs.existsSync(root)).toBe(false);
    expect(sh(t.path, ['worktree', 'list', '--porcelain'])).not.toContain(`disc-${created.id}`);
    expect(x.sessions.isLive(claude.id)).toBe(false); // the surviving participant was ended, not left running without a row
    const after = (await get(x.app, `/api/discussions/${created.id}`)).json();
    expect(after.participants.map((p: { harness: string }) => p.harness).sort()).toEqual(['claude', 'codex']);
    expect(after.participants.find((p: { harness: string }) => p.harness === 'codex')).toMatchObject({ status: 'failed' });
    expect(after.participants.find((p: { harness: string }) => p.harness === 'claude')).toMatchObject({ status: 'ended' });
  });
});
