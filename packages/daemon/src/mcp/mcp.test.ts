import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BatchRow, Repo } from '@overseer/shared';
import { openDb } from '../db/db';
import { Bus } from '../bus';
import { FakeAdapter } from '../harness/fake';
import { SessionManager } from '../sessions/manager';
import { MemoryTaskStore } from '../beads/memory';
import { phaseOf } from '../beads/store';
import { LocalMergeProvider } from '../git/provider';
import { Lifecycle } from '../lifecycle/lifecycle';
import { Plans } from '../plans/plans';
import { loadConfig } from '../config';
import { mkTmpRepo, commitFile, commitFileAsync, shAsync } from '../test/tmpgit';
import { until } from '../test/until';
import { log } from '../util/log';
import { buildBoard } from '../api/board';
import { Servers } from '../servers/servers';
import { Orchestrator } from '../orchestrator/orchestrator';

let servers: Servers;
let mcpPort: number;
import { registerMcp } from './server';
import { BOARD_COALESCE_MAX_MS, BOARD_COALESCE_MS, refreshBoard } from './tools';
import os from 'node:os';
import path from 'node:path';

const LOG_DIR = path.join(os.tmpdir(), 'overseer-test-sessions'); // the fake adapter never writes there

let app: FastifyInstance;
let client: Client;
let x: ReturnType<typeof setup>;
let testDataDir: string;
let initialDataDir: string;

function setup() {
  const t = mkTmpRepo();
  const db = openDb(':memory:', { batchIdSuffix: () => '' }); // fixed ids (r1-b1) keep the assertions readable; the random part is db.test's
  const bus = new Bus();
  const fake = new FakeAdapter();
  const sessions = new SessionManager(db, { claude: fake, codex: new FakeAdapter('codex') }, bus, LOG_DIR);
  const store = new MemoryTaskStore();
  const repo: Repo = { id: 'r1', path: t.path, base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 0, model_filter: null }; // the review-round test turns rounds on for itself
  db.repos.insert(repo);
  store.add(repo.path, { id: 'ov-1', title: 'First', description: 'd1' });
  store.add(repo.path, { id: 'ov-2', title: 'Second' }, ['ov-1']);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-data-'));
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), worktreesDir: t.worktreesDir };
  const lc = new Lifecycle({ db, store, sessions, bus, config, provider: () => new LocalMergeProvider(), notify: async () => {} });
  const plans = new Plans({ db, store, lifecycle: lc, bus, notify: async () => {} });
  const orch = new Orchestrator({ db, sessions, bus, config });
  return { db, bus, fake, sessions, store, repo, lc, config, plans, orch };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
  return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
}

async function orchestratorContext() {
  const isolated = setup();
  const instance = Fastify();
  await registerMcp(instance, { db: isolated.db, store: isolated.store, sessions: isolated.sessions, lifecycle: isolated.lc, bus: isolated.bus, plans: isolated.plans, servers: new Servers(isolated.db, path.join(isolated.config.dataDir, 'servers')), boardRefreshDelayMs: 1, originChatId: (id) => isolated.orch.originChatId(id) });
  await instance.listen({ port: 0, host: '127.0.0.1' });
  await isolated.orch.sendUser('the request');
  const session = isolated.db.sessions.latest('orchestrator')!.id;
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(instance.server.address() as { port: number }).port}/mcp/${session}`)));
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const t = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    return { isError: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return undefined; } })() };
  };
  const close = async () => { await c.close(); await instance.close(); fs.rmSync(isolated.config.dataDir, { recursive: true, force: true }); };
  return { x: isolated, session, call: callTool, close };
}

function programBatchRow(id: string, repoId = 'r1'): BatchRow {
  const at = '2026-09-28T00:00:00.000Z';
  return { id, repo_id: repoId, title: `Batch ${id}`, branch: `feature/${id}`, base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: at, updated_at: at, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null };
}

beforeAll(async () => {
  x = setup();
  initialDataDir = x.config.dataDir;
  app = Fastify();
  servers = new Servers(x.db, path.join(x.config.dataDir, 'servers'));
  await registerMcp(app, { db: x.db, store: x.store, sessions: x.sessions, lifecycle: x.lc, bus: x.bus, plans: x.plans, servers, boardRefreshDelayMs: 1, originChatId: (id) => x.orch.originChatId(id) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  mcpPort = (app.server.address() as { port: number }).port;
  const port = mcpPort;
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});
afterAll(async () => { await client.close(); await app.close(); fs.rmSync(initialDataDir, { recursive: true, force: true }); });
beforeEach(() => { testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-data-')); x.config.dataDir = testDataDir; });
afterEach(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

describe('Overseer MCP server tools', () => {
  const connect = async (url: string) => {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    return c;
  };
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

  /** An isolated install with one live orchestrator session and an MCP client on that session, so tool calls carry its identity. */
  const orchestratorSession = async () => {
    const isolated = setup();
    const instance = Fastify();
    await registerMcp(instance, { db: isolated.db, store: isolated.store, sessions: isolated.sessions, lifecycle: isolated.lc, bus: isolated.bus, plans: isolated.plans, servers: new Servers(isolated.db, path.join(isolated.config.dataDir, 'servers')), boardRefreshDelayMs: 1, originChatId: (id) => isolated.orch.originChatId(id) });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    await isolated.orch.sendUser('the request');
    const session = isolated.db.sessions.latest('orchestrator')!.id;
    const c = await connect(`http://127.0.0.1:${(instance.server.address() as { port: number }).port}/mcp/${session}`);
    const callTool = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args });
      const t = (r.content as { type: string; text: string }[])[0]?.text ?? '';
      return { isError: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return undefined; } })() };
    };
    const linkCount = () => (isolated.db.sql.prepare('SELECT COUNT(*) AS n FROM chat_batch_links').get() as { n: number }).n;
    const close = async () => { await c.close(); await instance.close(); fs.rmSync(isolated.config.dataDir, { recursive: true, force: true }); };
    return { x: isolated, session, call: callTool, linkCount, close };
  };

  it('links a follow-up sent mid-turn to the batch its bd note acts on, not the turn\'s first message', async () => {
    const ctx = await orchestratorSession();
    try {
      const first = ctx.x.db.chat.all().find((r) => r.role === 'user')!;
      await ctx.x.orch.sendUser('follow-up while the first turn runs');
      const followUp = ctx.x.db.chat.all().filter((r) => r.role === 'user').at(-1)!;
      const batch = await ctx.x.lc.createBatch('r1', 'Follow-up work');
      ctx.x.store.add(ctx.x.repo.path, { id: 'ov-f', title: 'Follow-up bead', labels: [`overseer:batch:${batch.id}`] });
      const raw = vi.spyOn(ctx.x.store, 'raw').mockResolvedValue({ id: 'ov-f', status: 'open', title: 'Follow-up bead' });
      try {
        expect((await ctx.call('bd', { repo: 'r1', args: ['note', 'ov-f', 'a note'] })).isError).toBe(false);
      } finally { raw.mockRestore(); }
      expect(ctx.x.db.chatLinks.forBatch(batch.id)).toEqual([followUp.id]);
      expect(ctx.x.db.chatLinks.forBatch(batch.id)).not.toContain(first.id);
    } finally { await ctx.close(); }
  });

  it('links a spawn_worker to the batch its batch_id names', async () => {
    const ctx = await orchestratorSession();
    try {
      const user = ctx.x.db.chat.all().find((r) => r.role === 'user')!;
      const batch = await ctx.x.lc.createBatch('r1', 'Spawn work');
      expect((await ctx.call('spawn_worker', { repo: 'r1', bead_id: 'ov-1', harness: 'claude', batch_id: batch.id })).isError).toBe(false);
      expect(ctx.x.db.chatLinks.forBatch(batch.id)).toEqual([user.id]);
    } finally { await ctx.close(); }
  });

  it('passes an explicit stack base to create_batch and returns the stored base branch', async () => {
    const ctx = await orchestratorSession();
    try {
      ctx.x.db.repos.update('r1', { merge_mode: 'gitlab-mr' });
      const origin = path.join(path.dirname(ctx.x.repo.path), 'origin.git');
      await shAsync(ctx.x.repo.path, ['clone', '-q', '--bare', ctx.x.repo.path, origin]);
      await shAsync(ctx.x.repo.path, ['remote', 'add', 'origin', origin]);
      const other = path.join(path.dirname(ctx.x.repo.path), 'other');
      await shAsync(ctx.x.repo.path, ['clone', '-q', origin, other]);
      await shAsync(other, ['switch', '-q', '-c', 'topic']);
      await commitFileAsync(other, 'topic.txt', 'stack base\n', 'topic base');
      await shAsync(other, ['push', '-q', 'origin', 'topic']);

      const result = await ctx.call('create_batch', { repo: 'r1', title: 'Stacked by MCP', base: 'topic' });
      expect(result.json).toMatchObject({ batch_id: 'r1-b1', branch: 'feature/stacked-by-mcp', base_branch: 'topic' });
      expect(ctx.x.db.batches.get('r1-b1')?.base_branch).toBe('topic');
    } finally { await ctx.close(); }
  });

  it('retarget_batch requires GitLab and a base create_batch accepts', async () => {
    const ctx = await orchestratorSession();
    try {
      const batch = await ctx.x.lc.createBatch('r1', 'Retarget me');
      expect((await ctx.call('retarget_batch', { repo: 'r1', batch_id: batch.id, base: 'main' })).text).toContain('only supported for gitlab-mr');
      ctx.x.db.repos.update('r1', { merge_mode: 'gitlab-mr' });
      const target = await ctx.x.lc.createBatch('r1', 'Target branch', 'topic', null, 'main');
      expect((await ctx.call('retarget_batch', { repo: 'r1', batch_id: batch.id, base: '   ' })).isError).toBe(true);
      expect((await ctx.call('retarget_batch', { repo: 'r1', batch_id: batch.id, base: 'missing-branch' })).text).toContain('base branch missing-branch is unavailable on origin');
      expect(ctx.x.db.batches.get(batch.id)?.base_branch).toBe('main');
      const result = await ctx.call('retarget_batch', { repo: 'r1', batch_id: batch.id, base: target.branch });
      expect(result.json).toEqual({ retargeted: true, batch_id: batch.id, base_branch: 'topic', mr_url: null, mr_updated: null });
      expect(ctx.x.db.batches.get(batch.id)?.base_branch).toBe('topic');
    } finally { await ctx.close(); }
  });

  it('worker_diff uses the bead worktree base branch', async () => {
    const ctx = await orchestratorSession();
    const x = ctx.x;
    try {
      const seedPath = path.join(path.dirname(x.repo.path), 'worker-diff-base');
      const batchBranch = 'feature/worker-diff-base';
      await shAsync(x.repo.path, ['worktree', 'add', '-b', batchBranch, seedPath, 'main']);
      await commitFileAsync(seedPath, 'stack-only.txt', 'base commit\n', 'stack base');
      await shAsync(x.repo.path, ['worktree', 'remove', seedPath]);
      const batchId = x.db.batches.nextId('r1');
      const now = new Date().toISOString();
      x.db.batches.insert({ id: batchId, repo_id: 'r1', title: 'Stacked diff', branch: batchBranch, base_branch: 'main', status: 'open', note: null, history: null, mr_url: null, conflict_files: null, created_at: now, updated_at: now, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
      x.store.add(x.repo.path, { id: 'ov-diffbase', title: 'Stacked diff bead', description: 'Use the stack base' });

      expect((await ctx.call('spawn_worker', { repo: 'r1', bead_id: 'ov-diffbase', harness: 'claude', batch_id: batchId })).isError).toBe(false);
      expect(x.db.worktrees.get('ov-diffbase')?.base_branch).toBe(batchBranch);
      expect((await ctx.call('worker_diff', { repo: 'r1', bead_id: 'ov-diffbase' })).json).toBe('');
    } finally { await ctx.close(); }
  });

  it('links a message_worker to the batch of the bead it addresses', async () => {
    const ctx = await orchestratorSession();
    try {
      const user = ctx.x.db.chat.all().find((r) => r.role === 'user')!;
      const batch = await ctx.x.lc.createBatch('r1', 'Message work');
      ctx.x.store.add(ctx.x.repo.path, { id: 'ov-msg', title: 'Message bead', labels: [`overseer:batch:${batch.id}`] });
      await ctx.x.lc.spawnWorker('r1', 'ov-msg', { harness: 'claude', batchId: batch.id });
      expect((await ctx.call('message_worker', { repo: 'r1', bead_id: 'ov-msg', text: 'status?' })).isError).toBe(false);
      expect(ctx.x.db.chatLinks.forBatch(batch.id)).toEqual([user.id]);
    } finally { await ctx.close(); }
  });

  it('records no link for a bead that belongs to no batch', async () => {
    const ctx = await orchestratorSession();
    try {
      ctx.x.store.add(ctx.x.repo.path, { id: 'ov-nb', title: 'No batch' });
      await ctx.x.lc.spawnWorker('r1', 'ov-nb', { harness: 'claude' });
      expect((await ctx.call('message_worker', { repo: 'r1', bead_id: 'ov-nb', text: 'hello' })).isError).toBe(false);
      expect(ctx.linkCount()).toBe(0);
    } finally { await ctx.close(); }
  });

  it('records no link for a batch created during a notice-only turn', async () => {
    const ctx = await orchestratorSession();
    try {
      ctx.x.bus.emit('event', { id: 1, session_id: ctx.session, type: 'turn_end', payload: {}, seq: 1, ts: new Date().toISOString() });
      await ctx.x.orch.systemMessage('a notice', { wake: true });
      const id = (await ctx.call('create_batch', { repo: 'r1', title: 'Notice work' })).json.batch_id as string;
      expect(ctx.x.db.batches.get(id)?.origin_chat_id).toBeNull();
      expect(ctx.x.db.chatLinks.forBatch(id)).toEqual([]);
    } finally { await ctx.close(); }
  });

  it('records one link when the same message is acted on for a batch twice', async () => {
    const ctx = await orchestratorSession();
    try {
      const user = ctx.x.db.chat.all().find((r) => r.role === 'user')!;
      const batch = await ctx.x.lc.createBatch('r1', 'Twice');
      ctx.x.store.add(ctx.x.repo.path, { id: 'ov-twice', title: 'Twice bead', labels: [`overseer:batch:${batch.id}`] });
      await ctx.x.lc.spawnWorker('r1', 'ov-twice', { harness: 'claude', batchId: batch.id });
      await ctx.call('message_worker', { repo: 'r1', bead_id: 'ov-twice', text: 'one' });
      await ctx.call('message_worker', { repo: 'r1', bead_id: 'ov-twice', text: 'two' });
      expect(ctx.x.db.chatLinks.forBatch(batch.id)).toEqual([user.id]);
      expect(ctx.linkCount()).toBe(1);
    } finally { await ctx.close(); }
  });

  it('links one message to every batch it is acted on for, and the board carries both', async () => {
    const ctx = await orchestratorSession();
    try {
      const user = ctx.x.db.chat.all().find((r) => r.role === 'user')!;
      const first = (await ctx.call('create_batch', { repo: 'r1', title: 'First' })).json.batch_id as string;
      const second = (await ctx.call('create_batch', { repo: 'r1', title: 'Second' })).json.batch_id as string;
      expect(ctx.x.db.chatLinks.forBatch(first)).toEqual([user.id]);
      expect(ctx.x.db.chatLinks.forBatch(second)).toEqual([user.id]);
      const board = await buildBoard(ctx.x.db, ctx.x.store);
      const rows = board.repos[0]!.batches.filter((b) => b.id === first || b.id === second);
      expect(rows.map((b) => b.linked_chat_ids)).toEqual([[user.id], [user.id]]);
    } finally { await ctx.close(); }
  });

  it('attaches a batch created in answer to a follow-up to the follow-up, not the turn that started', async () => {
    const ctx = await orchestratorSession();
    try {
      const first = ctx.x.db.chat.all().find((r) => r.role === 'user')!;
      await ctx.x.orch.sendUser('follow-up while the first turn runs');
      const followUp = ctx.x.db.chat.all().filter((r) => r.role === 'user').at(-1)!;
      const id = (await ctx.call('create_batch', { repo: 'r1', title: 'Follow-up batch' })).json.batch_id as string;
      expect(ctx.x.db.batches.get(id)?.origin_chat_id).toBe(followUp.id);
      expect(ctx.x.db.chatLinks.forBatch(id)).toEqual([followUp.id]);
      expect(ctx.x.db.chatLinks.forBatch(id)).not.toContain(first.id);
    } finally { await ctx.close(); }
  });

  it('stores one user message on both batches created through its orchestrator session', async () => {
    const isolated = setup();
    const instance = Fastify();
    await registerMcp(instance, { db: isolated.db, store: isolated.store, sessions: isolated.sessions, lifecycle: isolated.lc, bus: isolated.bus, plans: isolated.plans, servers: new Servers(isolated.db, path.join(isolated.config.dataDir, 'servers')), originChatId: (id) => isolated.orch.originChatId(id) });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    await isolated.orch.sendUser('make two changes');
    const session = isolated.db.sessions.latest('orchestrator')!.id;
    const userId = isolated.db.chat.all().find((r) => r.role === 'user' && r.text === 'make two changes')!.id;
    const port = (instance.server.address() as { port: number }).port;
    const c = await connect(`http://127.0.0.1:${port}/mcp/${session}`);
    try {
      for (const title of ['Origin first', 'Origin second']) {
        const result = await c.callTool({ name: 'create_batch', arguments: { repo: 'r1', title } });
        expect(result.isError).toBeFalsy();
        const id = JSON.parse(text(result)).batch_id as string;
        expect(isolated.db.batches.get(id)?.origin_chat_id).toBe(userId);
      }
      isolated.bus.emit('event', { id: 1, session_id: session, type: 'turn_end', payload: {}, seq: 1, ts: new Date().toISOString() });
      await isolated.orch.systemMessage('new work arrived', { wake: true });
      const noticeResult = await c.callTool({ name: 'create_batch', arguments: { repo: 'r1', title: 'Notice work' } });
      expect(noticeResult.isError).toBeFalsy();
      expect(isolated.db.batches.get(JSON.parse(text(noticeResult)).batch_id)?.origin_chat_id).toBeNull();
    } finally { await c.close(); await instance.close(); fs.rmSync(isolated.config.dataDir, { recursive: true, force: true }); }
  });

  it('refuses a server tool on the identity-less /mcp url', async () => {
    const r = await client.callTool({ name: 'start_server', arguments: { command: 'node -e ""' } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toMatch(/worker session only/);
  });

  it('starts, lists and stops a server on the per-session url', async () => {
    const s = { id: `sess-${Date.now()}`, harness: 'claude', role: 'worker' as const, bead_id: 'srv-test-bead', repo_id: 'srv-test-repo', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: process.cwd(), status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null, resolved_model: null, usage_baseline: null, batch_id: null, log_path: null, log_offset: 0, verify_only: 0, needs_server: 0, tier: null, model: null, account: null } as unknown as Parameters<typeof x.db.sessions.insert>[0];
    x.db.sessions.insert(s);
    const c = await connect(`http://127.0.0.1:${mcpPort}/mcp/${s.id}`);
    try {
      const started = JSON.parse(text(await c.callTool({ name: 'start_server', arguments: { command: `node -e "console.log('up'); setInterval(()=>{},1000)"` } })));
      expect(started.server_id).toMatch(/^srv-/);

      const listed = JSON.parse(text(await c.callTool({ name: 'list_servers', arguments: {} })));
      expect(listed.map((r: { server_id: string }) => r.server_id)).toEqual([started.server_id]);

      await c.callTool({ name: 'stop_server', arguments: { server_id: started.server_id } });
      expect(servers.running(s.id)).toHaveLength(0);
    } finally { await c.close(); }
  });
});

describe('Overseer MCP', () => {
  it('lists the tools', async () => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['abandon_batch', 'accept_review', 'add_to_program', 'ask_user', 'batch_retrospective', 'bd', 'close_bead', 'create_batch', 'create_program', 'interrupt_worker', 'list_programs', 'list_servers', 'list_batches', 'list_repos', 'list_tasks', 'log_program_entry', 'merge_batch', 'message_worker', 'propose_plan', 'reject_batch', 'request_batch_review', 'request_merge', 'retarget_batch', 'retry_verification', 'server_logs', 'set_merge_order', 'spawn_worker', 'start_server', 'stop_server', 'submit_review', 'worker_diff', 'worker_status'].sort());
    expect(tools.find((t) => t.name === 'create_batch')?.description).toContain('Pass base only when the user names a branch to stack the work on, and only in a gitlab-mr repository.');
    expect(tools.find((t) => t.name === 'list_repos')?.description).toContain('review command (`review_command`, null when none: the daemon skips the pre-review suite)');
    expect(tools.find((t) => t.name === 'list_repos')?.description).toContain('The `model_filter` field restricts which harness, model and account dispatches for that repository may use; null means the global tiers, and review critics are not filtered.');
    expect(tools.find((t) => t.name === 'request_batch_review')?.description).toContain('quote it in the review note');
    expect(tools.find((t) => t.name === 'retarget_batch')?.description).toContain('Call only after the user asked you to retarget that batch.');
    expect(tools.find((t) => t.name === 'spawn_worker')?.description).toContain('Without verify_command, a passing set of Check lines closes as worker-reported');
    expect(tools.find((t) => t.name === 'spawn_worker')?.description).toContain('verify_command is valid only with verify_only: true');
    expect(tools.find((t) => t.name === 'spawn_worker')?.description).toContain('a re-dispatch with verify_only: true and no new verify_command keeps the saved command');
    expect(tools.find((t) => t.name === 'spawn_worker')?.description).toContain('reopens as verify_incomplete');
    expect(tools.find((t) => t.name === 'spawn_worker')?.description).toContain('Pass harness with tier to force that CLI within that tier');
    expect(tools.find((t) => t.name === 'spawn_worker')?.description).toContain('never moved to another harness or tier; automatic retries keep both');
    expect(tools.find((t) => t.name === 'batch_retrospective')?.description).toContain('verify_incomplete');
    expect(tools.find((t) => t.name === 'batch_retrospective')?.description).toContain('cut to 400 characters');
    expect(tools.find((t) => t.name === 'batch_retrospective')?.description).toContain('full: true');
    expect(tools.find((t) => t.name === 'batch_retrospective')?.description).toContain('bead_id');
    expect(tools.find((t) => t.name === 'bd')?.description).toContain('dep list returns id, title and status per dependency');
    expect(tools.find((t) => t.name === 'bd')?.description).toContain('show is how to read a bead');
  });
  it('creates, fills and reads a program, including empty order and duplicate entries', async () => {
    const ctx = await orchestratorContext();
    const x = ctx.x;
    const call = ctx.call;
    try {
      const created = await call('create_program', { repo: 'r1', title: '  Stories 365 and 366  ' });
      expect(created.isError).toBe(false);
      expect(created.json).toMatchObject({ repo_id: 'r1', title: 'Stories 365 and 366' });
      const programId = created.json.program_id as string;
      const sourceChatId = x.db.chat.all().find((row) => row.role === 'user')!.id;
      expect(x.db.programs.get(programId)).toMatchObject({ id: programId, repo_id: 'r1', title: 'Stories 365 and 366', status: 'open', origin_chat_id: sourceChatId });

      const firstId = 'r1-program-tool-first';
      const secondId = 'r1-program-tool-second';
      x.db.batches.insert(programBatchRow(firstId));
      x.db.batches.insert(programBatchRow(secondId));
      x.store.add(x.repo.path, { id: 'ov-program-tool', title: 'Program bead', labels: [`overseer:batch:${secondId}`] });
      expect((await call('add_to_program', { program_id: programId, batch_id: firstId, lane: '#9365 → #9366' })).json).toMatchObject({ added: true, position: 0, after_batch_id: null });
      expect((await call('add_to_program', { program_id: programId, batch_id: secondId, lane: '#9365 → #9366', after_batch_id: firstId })).json).toMatchObject({ added: true, position: 1, after_batch_id: firstId });
      const duplicateMember = await call('add_to_program', { program_id: programId, batch_id: firstId, lane: '#9365 → #9366' });
      expect(duplicateMember.isError).toBe(true);
      expect(duplicateMember.text).toContain(`batch ${firstId} is already in program ${programId}`);
      const decision = '  Keep this decision verbatim.\n';
      expect((await call('log_program_entry', { program_id: programId, kind: 'decision', text: decision })).isError).toBe(false);
      await call('log_program_entry', { program_id: programId, kind: 'note', text: 'Review after both batches land.' });
      await call('log_program_entry', { program_id: programId, kind: 'note', text: 'Review after both batches land.' });
      expect((await call('set_merge_order', { program_id: programId, batch_ids: [secondId, firstId] })).json).toMatchObject({ saved: true, batch_ids: [secondId, firstId] });

      const listed = await call('list_programs', { repo: 'r1' });
      expect(listed.isError).toBe(false);
      expect((listed.json as { id: string }[]).map((program) => program.id)).toContain(programId);
      const detail = await call('list_programs', { repo: 'r1', program_id: programId });
      expect(detail.json).toMatchObject({
        id: programId,
        batches: [
          { batch_id: firstId, lane: '#9365 → #9366', position: 0, title: `Batch ${firstId}`, status: 'open', beads_total: 0, beads_done: 0, beads_closed: 0 },
          { batch_id: secondId, lane: '#9365 → #9366', position: 1, title: `Batch ${secondId}`, status: 'open', beads_total: 1, beads_done: 0, beads_closed: 0 },
        ],
        waits: [{ batch_id: secondId, prerequisite_batch_id: firstId, released: false }],
        entries: [
          { kind: 'decision', text: decision, source_chat_id: sourceChatId },
          { kind: 'note', text: 'Review after both batches land.', source_chat_id: sourceChatId },
          { kind: 'note', text: 'Review after both batches land.', source_chat_id: sourceChatId },
        ],
        merge_order: [secondId, firstId],
      });
      expect((await call('set_merge_order', { program_id: programId, batch_ids: [] })).json).toMatchObject({ saved: true, batch_ids: [] });
      expect((await call('list_programs', { repo: 'r1', program_id: programId })).json.merge_order).toEqual([]);

      const empty = await call('create_program', { repo: 'r1', title: 'Empty program' });
      const emptyId = empty.json.program_id as string;
      expect((await call('list_programs', { repo: 'r1', program_id: emptyId })).json).toMatchObject({ batches: [], waits: [], entries: [], merge_order: [] });
      const emptyRepo = { ...x.repo, id: 'r-empty', path: `${x.repo.path}-empty` };
      x.db.repos.insert(emptyRepo);
      expect((await call('list_programs', { repo: 'r-empty' })).json).toEqual([]);
      x.db.repos.delete('r-empty');
      const removed = await call('list_programs', { repo: 'r1', program_id: 'removed-program' });
      expect(removed.isError).toBe(true);
      expect(removed.text).toContain('program removed-program not found in repo r1');
    } finally { await ctx.close(); }
  });

  it('refuses unknown and cross-repo batches when adding to a program', async () => {
    const ctx = await orchestratorContext();
    const x = ctx.x;
    const call = ctx.call;
    try {
      const programId = (await call('create_program', { repo: 'r1', title: 'Program validation' })).json.program_id as string;
      const missing = await call('add_to_program', { program_id: programId, batch_id: 'missing-batch', lane: 'main' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('batch missing-batch not found');
      x.db.batches.insert(programBatchRow('r1-program-prerequisite-check'));
      const missingPrerequisite = await call('add_to_program', { program_id: programId, batch_id: 'r1-program-prerequisite-check', lane: 'main', after_batch_id: 'missing-prerequisite' });
      expect(missingPrerequisite.isError).toBe(true);
      expect(missingPrerequisite.text).toContain('batch missing-prerequisite not found');

      x.db.repos.insert({ ...x.repo, id: 'r2', path: `${x.repo.path}-r2` });
      x.db.batches.insert(programBatchRow('r2-foreign-batch', 'r2'));
      const foreign = await call('add_to_program', { program_id: programId, batch_id: 'r2-foreign-batch', lane: 'main' });
      expect(foreign.isError).toBe(true);
      expect(foreign.text).toContain('belongs to repo r2, not program');
      x.db.batches.insert(programBatchRow('r1-program-foreign-prerequisite', 'r1'));
      const foreignPrerequisite = await call('add_to_program', { program_id: programId, batch_id: 'r1-program-foreign-prerequisite', lane: 'main', after_batch_id: 'r2-foreign-batch' });
      expect(foreignPrerequisite.isError).toBe(true);
      expect(foreignPrerequisite.text).toContain('belongs to repo r2, not program');
    } finally { await ctx.close(); }
  });

  it('refuses a wait that creates a cycle without adding the batch', async () => {
    const ctx = await orchestratorContext();
    const x = ctx.x;
    const call = ctx.call;
    try {
      const programId = (await call('create_program', { repo: 'r1', title: 'Program wait cycle' })).json.program_id as string;
      const firstId = 'r1-program-cycle-first';
      const secondId = 'r1-program-cycle-second';
      x.db.batches.insert(programBatchRow(firstId));
      x.db.batches.insert(programBatchRow(secondId));
      x.db.programBatches.insert({ program_id: programId, batch_id: firstId, lane: 'main', position: 0 });
      x.db.batchWaits.insert({ batch_id: firstId, prerequisite_batch_id: secondId });
      const cycle = await call('add_to_program', { program_id: programId, batch_id: secondId, lane: 'main', after_batch_id: firstId });
      expect(cycle.isError).toBe(true);
      expect(cycle.text).toContain(`wait from batch ${secondId} to ${firstId} would create a cycle`);
      expect(x.db.programBatches.forProgram(programId)).toEqual([{ program_id: programId, batch_id: firstId, lane: 'main', position: 0 }]);
    } finally { await ctx.close(); }
  });

  it('refuses merge-order batches outside the program and duplicate ids, and permits clearing the order', async () => {
    const ctx = await orchestratorContext();
    const x = ctx.x;
    const call = ctx.call;
    try {
      const programId = (await call('create_program', { repo: 'r1', title: 'Program merge order' })).json.program_id as string;
      const memberId = 'r1-program-order-member';
      const outsideId = 'r1-program-order-outside';
      x.db.batches.insert(programBatchRow(memberId));
      x.db.batches.insert(programBatchRow(outsideId));
      await call('add_to_program', { program_id: programId, batch_id: memberId, lane: 'main' });
      const outside = await call('set_merge_order', { program_id: programId, batch_ids: [outsideId] });
      expect(outside.isError).toBe(true);
      expect(outside.text).toContain(`batch ${outsideId} is not in program ${programId}`);
      await call('set_merge_order', { program_id: programId, batch_ids: [memberId] });
      const duplicate = await call('set_merge_order', { program_id: programId, batch_ids: [memberId, memberId] });
      expect(duplicate.isError).toBe(true);
      expect(duplicate.text).toContain(`merge order repeats batch ${memberId}`);
      expect(x.db.mergeOrder.forProgram(programId)).toEqual([memberId]);
      expect((await call('set_merge_order', { program_id: programId, batch_ids: [] })).isError).toBe(false);
      expect(x.db.mergeOrder.forProgram(programId)).toEqual([]);
    } finally { await ctx.close(); }
  });

  it('refuses blank program titles, lanes and entry text', async () => {
    const ctx = await orchestratorContext();
    const x = ctx.x;
    const call = ctx.call;
    try {
      expect((await call('create_program', { repo: 'r1', title: '   ' })).isError).toBe(true);
      const programId = (await call('create_program', { repo: 'r1', title: 'Program nonblank validation' })).json.program_id as string;
      x.db.batches.insert(programBatchRow('r1-program-nonblank'));
      expect((await call('add_to_program', { program_id: programId, batch_id: 'r1-program-nonblank', lane: '  ' })).isError).toBe(true);
      expect((await call('log_program_entry', { program_id: programId, kind: 'note', text: '  ' })).isError).toBe(true);
    } finally { await ctx.close(); }
  });

  it('list_repos and list_tasks with filters', async () => {
    // The orchestrator reads repository commands and merge mode from here, never from bead notes.
    expect((await call('list_repos')).json).toEqual([{ id: 'r1', path: x.repo.path, base_branch: 'main', verify_command: null, review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 0, verify_suspect: null, model_filter: null, verification: 'no verify command configured: branches land without a check' }]);
    const modelFilter = { harnesses: ['claude' as const], models: ['future-model'], accounts: ['account-1'] };
    x.db.repos.update('r1', { model_filter: modelFilter });
    expect((await call('list_repos')).json[0]).toMatchObject({ model_filter: modelFilter });
    x.db.repos.update('r1', { model_filter: null });
    x.db.repos.update('r1', { verify_command: 'pnpm test' });
    expect((await call('list_repos')).json[0]).toMatchObject({ verify_command: 'pnpm test', verification: "runs verify command `pnpm test` in the bead's worktree after the worker ends" });
    x.db.repos.update('r1', { review_command: 'pnpm test:review' });
    expect((await call('list_repos')).json[0]).toMatchObject({ review_command: 'pnpm test:review' });
    x.db.repos.update('r1', { verify_command: null });
    x.db.repos.update('r1', { review_command: null });
    const ready = (await call('list_tasks', { repo: 'r1', filter: 'ready' })).json as { id: string; column: string }[];
    expect(ready.map((b) => b.id)).toEqual(['ov-1']);
    expect(ready[0]!.column).toBe('ready');
    const all = (await call('list_tasks', { repo: 'r1', filter: 'all' })).json as { id: string; column: string }[];
    expect(all.map((b) => [b.id, b.column])).toEqual([['ov-1', 'ready'], ['ov-2', 'blocked']]);
    expect((await call('list_tasks', { repo: 'nope', filter: 'all' })).isError).toBe(true);
  });

  it('list_batches returns the recorded review check', async () => {
    const check = { status: 'pass' as const, command: 'pnpm test', head_sha: 'abc123', exit_code: 0, duration_ms: 42, output_tail: 'Tests 2 passed', counts: { passed: 2, failed: 0, skipped: 0, todo: 0, flaky: 0 } };
    x.db.batches.insert({ id: 'r1-b1', repo_id: 'r1', title: 'Review check', branch: 'feature/review-check', base_branch: 'main', status: 'review', note: null, history: null, mr_url: null, conflict_files: null, created_at: '2026-09-24T00:00:00.000Z', updated_at: '2026-09-24T00:00:00.000Z', merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null, review_check: check });
    expect((await call('list_batches', { repo: 'r1', batch_id: 'r1-b1' })).json).toMatchObject({ review_check: check });
    x.db.batches.delete('r1-b1');
  });
  it('propose_plan stores a draft and refuses an invalid plan', async () => {
    const ok = await call('propose_plan', { repo: 'r1', title: 'Accounts', steps: [{ title: 'Table', description: 'd' }, { title: 'Login', description: '', dependsOn: [0] }] });
    expect(ok.isError).toBe(false);
    expect(ok.json).toMatchObject({ plan_id: expect.stringMatching(/^r1-p\d+$/), steps: 2 });
    expect(ok.json.url).toBe(`#plan/${ok.json.plan_id}`);
    expect(x.db.plans.get(ok.json.plan_id)).toMatchObject({ status: 'draft', title: 'Accounts' });
    const bad = await call('propose_plan', { repo: 'r1', title: 'Accounts', steps: [{ title: 'Table', description: '', dependsOn: [0] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Step 1 cannot depend on itself.');
  });
  it('bd passthrough returns parsed JSON or an error', async () => {
    const r = await call('bd', { repo: 'r1', args: ['show', 'ov-1'] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ id: 'ov-1' });
    expect((await call('bd', { repo: 'r1', args: ['explode'] })).isError).toBe(true);
  });
  it('trims a write command to the id, status and title, and keeps a read command whole', async () => {
    const long = 'x'.repeat(4000);
    const bead = { id: 'ov-9', title: 'Ninth', description: long, status: 'open', labels: ['overseer:batch:r1-b1'], notes: long };
    const raw = vi.spyOn(x.store, 'raw');
    try {
      raw.mockResolvedValueOnce(bead);
      const created = await call('bd', { repo: 'r1', args: ['create', 'Ninth', '-d', long] });
      expect(created.isError).toBe(false);
      expect(created.json).toEqual({ id: 'ov-9', status: 'open', title: 'Ninth', labels: ['overseer:batch:r1-b1'] });
      expect(created.json).not.toHaveProperty('description');
      // The result the orchestrator re-pays on every later turn, before and after the trim.
      const before = JSON.stringify(bead, null, 2).length;
      console.log(`[bd create size] before=${before} after=${created.text.length}`);
      expect(before).toBeGreaterThan(8000);
      expect(created.text.length).toBeLessThan(200);

      raw.mockResolvedValueOnce(bead);
      const note = await call('bd', { repo: 'r1', args: ['note', 'ov-9', 'a note'] });
      expect(note.json).toEqual({ id: 'ov-9', status: 'open', title: 'Ninth' });
      expect(note.json).not.toHaveProperty('notes');

      raw.mockResolvedValueOnce({ status: 'added', issue_id: 'ov-9', depends_on_id: 'ov-2', type: 'blocks' });
      expect((await call('bd', { repo: 'r1', args: ['dep', 'add', 'ov-9', 'ov-2'] })).json).toEqual({ issue_id: 'ov-9', depends_on_id: 'ov-2', type: 'blocks' });

      raw.mockResolvedValueOnce([bead]);
      expect((await call('bd', { repo: 'r1', args: ['dep', 'list', 'ov-9'] })).json).toEqual([{ id: 'ov-9', status: 'open', title: 'Ninth' }]);

      raw.mockResolvedValueOnce([bead]); // bd update answers an array of the issues it wrote
      expect((await call('bd', { repo: 'r1', args: ['update', 'ov-9', '--append-notes', 'x'] })).json).toEqual([{ id: 'ov-9', status: 'open', title: 'Ninth' }]);

      raw.mockResolvedValueOnce({ status: 'removed', issue_id: 'ov-9', depends_on_id: 'ov-2' });
      expect((await call('bd', { repo: 'r1', args: ['dep', 'remove', 'ov-9', 'ov-2'] })).json).toEqual({ issue_id: 'ov-9', depends_on_id: 'ov-2' });

      raw.mockResolvedValueOnce([{ status: 'added', issue_id: 'ov-9', label: 'extra' }]);
      expect((await call('bd', { repo: 'r1', args: ['label', 'add', 'ov-9', 'extra'] })).json).toEqual([{ id: 'ov-9', status: 'added' }]);

      raw.mockResolvedValueOnce({ ok: true }); // a shape the trim does not know is handed back whole, never emptied
      expect((await call('bd', { repo: 'r1', args: ['close', 'ov-9'] })).json).toEqual({ ok: true });

      // show is a read: the whole bead comes back, description and notes included.
      expect((await call('bd', { repo: 'r1', args: ['show', 'ov-1'] })).json).toMatchObject({ id: 'ov-1', description: 'd1' });
    } finally { raw.mockRestore(); }
  });
  it('refuses verify_command without verify_only and a blank verify_command', async () => {
    const beadId = 'ov-verify-command-guard';
    x.store.add(x.repo.path, { id: beadId, title: 'Verify command guard' });
    const withoutFlag = await call('spawn_worker', { repo: 'r1', bead_id: beadId, harness: 'claude', verify_command: 'node -e "process.exit(0)"' });
    const blank = await call('spawn_worker', { repo: 'r1', bead_id: beadId, harness: 'claude', verify_only: true, verify_command: '  ' });
    expect({ withoutFlag: [withoutFlag.isError, withoutFlag.text], blank: [blank.isError, blank.text], sessions: x.db.sessions.forBead(beadId) }).toMatchObject({
      withoutFlag: [true, expect.stringContaining('verify_command requires verify_only: true')],
      blank: [true, expect.stringContaining('verify_command must not be blank')],
      sessions: [],
    });
  });
  it('spawn_worker keeps and runs a saved verify_command on a verify-only re-dispatch without the field', async () => {
    const beadId = 'ov-verify-redispatch';
    const command = `node -e "console.log('Tests 3 passed (3)')"`;
    x.store.add(x.repo.path, { id: beadId, title: 'Verify re-dispatch' });
    const first = await call('spawn_worker', { repo: 'r1', bead_id: beadId, harness: 'claude', verify_only: true, verify_command: command });
    const firstId = first.json.session_id as string;
    await call('interrupt_worker', { repo: 'r1', bead_id: beadId });
    await until(async () => (await x.store.show(x.repo.path, beadId))?.status === 'open', 5000, 'first verify-only attempt reopens');
    const second = await call('spawn_worker', { repo: 'r1', bead_id: beadId, harness: 'claude', verify_only: true });
    const secondId = second.json.session_id as string;
    x.fake.emit(x.sessions.handleOf(secondId)!, { type: 'turn_end', nativeSessionId: 'verify-retry', cost: 0 });
    await until(() => x.db.worktrees.get(beadId)?.verify_only_result?.status === 'pass', 5000, 'saved command passes');
    // The command result is stored before the asynchronous evidence check and close finish.
    await until(async () => {
      const bead = await x.store.show(x.repo.path, beadId);
      return bead?.status === 'closed' && phaseOf(bead) === 'verified';
    }, 5000, 'saved command closes as verified');
    const worktree = x.db.worktrees.get(beadId)!;
    const bead = await x.store.show(x.repo.path, beadId);
    expect({ firstEnded: x.db.sessions.get(firstId)?.status, verifyOnly: x.db.sessions.get(secondId)?.verify_only, command: worktree.verify_command, result: worktree.verify_only_result, phase: phaseOf(bead!), status: bead?.status }).toMatchObject({
      firstEnded: 'ended',
      verifyOnly: 1,
      command,
      result: { status: 'pass', command, exit_code: 0 },
      phase: 'verified',
      status: 'closed',
    });
  });
  it('returns a failing bd command error text in full', async () => {
    const raw = vi.spyOn(x.store, 'raw').mockRejectedValueOnce(new Error('bd create failed: no label overseer:batch:r1-b1'));
    try {
      const r = await call('bd', { repo: 'r1', args: ['create', 'X'] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('bd create failed: no label overseer:batch:r1-b1');
    } finally { raw.mockRestore(); }
  });
  it('spawn, status, message, diff, request_merge', async () => {
    const s = await call('spawn_worker', { repo: 'r1', bead_id: 'ov-1', harness: 'claude' });
    expect(s.isError).toBe(false);
    const sessionId = (s.json as { session_id: string }).session_id;
    expect(sessionId).toBeTruthy();
    x.db.accounts.insert({ id: 'acct-work', name: 'Work account', label: 'Work', harness: 'claude', kind: 'oauth_token', secret: 'token', home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.sessions.update(sessionId, { account: 'acct-work' });
    expect((await call('spawn_worker', { repo: 'r1', bead_id: 'ov-1', harness: 'claude' })).text).toMatch(/already has a running session/);
    const h = x.sessions.handleOf(sessionId)!;
    x.fake.emit(h, { type: 'assistant_text', text: 'working on it' });
    x.fake.emit(h, { type: 'file_change', path: 'a.txt' });
    await until(() => x.sessions.status(sessionId).lastText === 'working on it');
    expect((await call('worker_status', { repo: 'r1', bead_id: 'ov-1' })).json).toMatchObject({ state: 'running', last_text: 'working on it', files: ['a.txt'], harness: 'claude', account: 'acct-work', account_name: 'Work account', account_label: 'Work' });
    await call('message_worker', { repo: 'r1', bead_id: 'ov-1', text: 'also add tests' });
    expect(x.fake.sent(h)).toContain('also add tests');
    const wt = x.db.worktrees.get('ov-1')!;
    commitFile(wt.path, 'a.txt', 'A\n', 'add a');
    expect((await call('worker_diff', { repo: 'r1', bead_id: 'ov-1' })).text).toContain('+A');
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0.2 });
    x.fake.emit(h, { type: 'turn_end', nativeSessionId: 'n', cost: 0.2 });
    await until(() => x.db.worktrees.get('ov-1')?.verify_status === 'pass', 5000, 'verify');
    const rm = await call('request_merge', { repo: 'r1', bead_id: 'ov-1', note: 'ready for review' });
    expect(rm.isError).toBe(false);
    expect(x.db.worktrees.get('ov-1')?.review_note).toBe('ready for review');
  });
  it('ask_user creates a question and returns immediately', async () => {
    const r = await call('ask_user', { question: 'Which DB?' });
    const id = (r.json as { question_id: number }).question_id;
    expect(x.db.chat.get(id)).toMatchObject({ role: 'assistant', kind: 'question', text: 'Which DB?', answer: null });
  });
  it('create_batch, spawn onto it, list_batches, request_batch_review', async () => {
    const created = (await call('create_batch', { repo: 'r1', title: 'Trend chart' })).json;
    expect(created).toMatchObject({ batch_id: 'r1-b1', branch: 'feature/trend-chart' });
    const spawned = (await call('spawn_worker', { repo: 'r1', bead_id: 'ov-1', harness: 'claude', batch_id: 'r1-b1' })).json;
    expect(spawned).toMatchObject({ bead_id: 'ov-1', batch_id: 'r1-b1' });
    expect(x.db.worktrees.get('ov-1')?.batch_id).toBe('r1-b1');
    const list = (await call('list_batches', { repo: 'r1' })).json;
    expect(list).toEqual([expect.objectContaining({ id: 'r1-b1', status: 'open', status_label: 'open', beads_total: 1, beads_done: 0 })]);
    const r = await call('request_batch_review', { repo: 'r1', batch_id: 'r1-b1', note: 'n' });
    expect(r.text).toMatch(/still open/);
  });
  it('bd create with a batch_id labels the bead for the batch, and list_batches counts it before any dispatch (round 15)', async () => {
    const raw = vi.spyOn(x.store, 'raw').mockResolvedValue({ id: 'ov-7' });
    expect((await call('bd', { repo: 'r1', args: ['create', 'Seventh', '-d', 'd'], batch_id: 'r1-b1' })).isError).toBe(false);
    expect(raw).toHaveBeenCalledWith(x.repo.path, ['create', 'Seventh', '-d', 'd', '--labels', 'overseer:batch:r1-b1']);
    raw.mockRestore();
    expect((await call('bd', { repo: 'r1', args: ['show', 'ov-1'], batch_id: 'r1-b1' })).text).toMatch(/applies to bd create only/);
    expect((await call('bd', { repo: 'r1', args: ['create', 'x'], batch_id: 'r1-b9' })).text).toMatch(/batch r1-b9 not found in r1/);
    x.store.add(x.repo.path, { id: 'ov-7', title: 'Seventh', labels: ['overseer:batch:r1-b1'] });
    const list = (await call('list_batches', { repo: 'r1' })).json;
    expect(list).toEqual([expect.objectContaining({ id: 'r1-b1', beads_total: 2, beads_done: 0, beads_closed: 0 })]);
  });
  it('a bd write refreshes the Board, so a bead created and not dispatched reaches it at once; a bd read does not (round 22 R22-1)', async () => {
    const boards: string[] = [];
    const off = x.bus.on('board', () => boards.push('board'));
    // The real bd writes the bead; the store stands in for it, with the label the tool appended.
    const raw = vi.spyOn(x.store, 'raw').mockImplementation(async (p: string, a: string[]) => x.store.add(p, { id: 'ov-8', title: 'Eighth', labels: [a[a.indexOf('--labels') + 1]!] }));
    try {
      const before = (await buildBoard(x.db, x.store)).repos[0]!;
      expect((await call('bd', { repo: 'r1', args: ['create', 'Eighth'], batch_id: 'r1-b1' })).isError).toBe(false);
      await until(() => boards.length === 1, 2000, 'the board refresh of a bd write');
      const after = (await buildBoard(x.db, x.store)).repos[0]!;
      expect(after.cards.find((c) => c.bead.id === 'ov-8')).toMatchObject({ column: 'ready', batch_id: 'r1-b1' });
      expect(after.batches[0]!.beads_total).toBe(before.batches[0]!.beads_total + 1);
      raw.mockResolvedValue({ id: 'ov-1' });
      expect((await call('bd', { repo: 'r1', args: ['show', 'ov-1'] })).isError).toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(boards).toEqual(['board']); // a read changes nothing, so it costs no board build
    } finally {
      off();
      raw.mockRestore();
    }
  });
  it('a throwing board listener leaves the bd write reported as the success it was, and its refresh still arrives (fix round 22 review M-1, M-3)', async () => {
    const boards: string[] = [];
    const off = x.bus.on('board', () => { boards.push('board'); throw new Error('a listener of another view threw'); });
    const raw = vi.spyOn(x.store, 'raw').mockResolvedValue({ ok: true });
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {}); // the throw is logged, not printed into the test output
    try {
      // How many refreshes a burst costs is a property of the scheduler and is counted on a driven clock below, where the answer
      // cannot depend on how fast these five HTTP round trips happen to be (fix round 23 review NB-2).
      for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) {
        expect((await call('bd', { repo: 'r1', args: ['create', title] })).isError).toBe(false);
      }
      await until(() => boards.length > 0, 2000, 'the coalesced board refresh');
      expect(logged).toHaveBeenCalledWith('mcp: a board listener threw', expect.any(Error));
    } finally {
      off();
      raw.mockRestore();
      logged.mockRestore();
    }
  });
  it('list_batches answers from the daemon rows alone when bd list fails (fix round 15 review M-1)', async () => {
    vi.spyOn(x.store, 'list').mockRejectedValueOnce(new Error('bd list failed: locked'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await call('list_batches', { repo: 'r1' });
      expect(r.isError).toBe(false);
      expect(r.json).toEqual([expect.objectContaining({ id: 'r1-b1', beads_total: 1, beads_done: 0 })]); // the dispatched bead only; the labelled one is in bd
      expect(error.mock.calls[0]?.[0]).toBe('mcp: bd list failed for list_batches; counting dispatched beads only');
    } finally {
      error.mockRestore();
    }
  });
  it('list_batches spells out that review is not merged', async () => {
    x.db.batches.update('r1-b1', { status: 'review' });
    const list = (await call('list_batches', { repo: 'r1' })).json as { id: string; status_label: string }[];
    expect(list.find((b) => b.id === 'r1-b1')?.status_label).toBe("in review (awaiting the user's review, not merged)");
    x.db.batches.update('r1-b1', { status: 'open' });
  });
  it('list_batches omits the long history and note by default, and batch_id returns that one batch with both', async () => {
    const long = 'x'.repeat(5000);
    const ids = ['r1-b-long1', 'r1-b-long2', 'r1-b-long3'];
    ids.forEach((id, i) => x.db.batches.insert({ id, repo_id: 'r1', title: `Long ${i}`, branch: `feature/long-${i}`, base_branch: 'main', status: 'open', note: long, history: long, mr_url: null, conflict_files: null, created_at: `2026-01-0${i + 1}T00:00:00.000Z`, updated_at: `2026-01-0${i + 1}T00:00:00.000Z`, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null }));

    const list = (await call('list_batches', { repo: 'r1' })).json as Record<string, unknown>[];
    const row = list.find((b) => b.id === ids[0])!;
    expect(row).not.toHaveProperty('history');
    expect(row).not.toHaveProperty('note');
    expect(row).toMatchObject({ id: ids[0], status: 'open', status_label: 'open', beads_total: 0, beads_done: 0, beads_closed: 0 });

    const full = (await call('list_batches', { repo: 'r1', batch_id: ids[0] })).json as Record<string, unknown>;
    expect(full).toMatchObject({ id: ids[0], status: 'open', status_label: 'open', beads_total: 0 });
    expect(full.history).toBe(long);
    expect(full.note).toBe(long);

    expect((await call('list_batches', { repo: 'r1', batch_id: 'r1-b99' })).isError).toBe(true);
    expect((await call('list_batches', { repo: 'r1', batch_id: 'r1-b99' })).text).toContain('batch r1-b99 not found in r1');

    // The character length of the default result for three batches that each carry a 5,000-character history, and of the same
    // three rows with history and note: this is the size the tool result spilled to a file over before the default changed.
    let before = 0;
    for (const id of ids) before += JSON.stringify((await call('list_batches', { repo: 'r1', batch_id: id })).json).length;
    const after = JSON.stringify(list.filter((b) => ids.includes(b.id as string))).length;
    console.log(`[list_batches size] before=${before} after=${after}`);
    expect(before).toBeGreaterThan(30_000);
    expect(after).toBeLessThan(2_000);
  });
  it('batch_retrospective trims by default, and full or bead_id return the uncut record', async () => {
    const id = 'r1-b-retro';
    x.db.batches.insert({ id, repo_id: 'r1', title: 'Retro', branch: 'feature/retro', base_branch: 'main', status: 'merged', note: null, history: null, mr_url: null, conflict_files: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:01:00.000Z', merged_at: '2026-01-01T00:01:00.000Z', merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    x.db.signals.insert({ batch_id: id, bead_id: 'ov-1', kind: 'reopen', text: `no_commits: ${'n'.repeat(400)}` });
    x.db.signals.insert({ batch_id: id, bead_id: 'ov-1', kind: 'redispatch', text: 'i'.repeat(400) });
    x.db.signals.insert({ batch_id: id, bead_id: 'ov-1', kind: 'redispatch', text: 'again' });
    x.db.signals.insert({ batch_id: id, bead_id: 'ov-2', kind: 'closed', text: 'c'.repeat(400) });
    x.db.signals.insert({ batch_id: id, bead_id: null, kind: 'rejection', text: 'r'.repeat(500) });

    const compact = (await call('batch_retrospective', { repo: 'r1', batch_id: id })).json;
    expect(compact.signals.rejections).toEqual([{ note: 'r'.repeat(400), truncated: true, ts: expect.any(String) }]);
    expect(compact.signals.reopens[0]).toMatchObject({ bead_id: 'ov-1', reason: 'no_commits', note: 'n'.repeat(300) });
    expect(compact.signals.closed[0]).toMatchObject({ bead_id: 'ov-2', note: 'c'.repeat(300) });
    expect(compact.signals.redispatches).toEqual([{ bead_id: 'ov-1', count: 2, instructions: ['i'.repeat(300), 'again'] }]);
    expect(compact.signals.corrections).toEqual([]);

    const full = (await call('batch_retrospective', { repo: 'r1', batch_id: id, full: true })).json;
    expect(full.signals.rejections[0].note).toBe('r'.repeat(500));
    expect(full.signals.rejections[0]).not.toHaveProperty('truncated');
    expect(full.signals.reopens[0].note).toBe('n'.repeat(400));
    expect(full.signals.closed[0].note).toBe('c'.repeat(400));
    expect(full.signals.redispatches.map((r: { instructions: string }) => r.instructions)).toEqual(['i'.repeat(400), 'again']);
    expect(full.counts).toEqual(compact.counts);

    const one = (await call('batch_retrospective', { repo: 'r1', batch_id: id, bead_id: 'ov-1' })).json;
    expect(one.signals.reopens[0].note).toBe('n'.repeat(400));
    expect(one.signals.redispatches.map((r: { instructions: string }) => r.instructions)).toEqual(['i'.repeat(400), 'again']);
    expect(one.signals.closed).toEqual([]);
    expect(one.crashes).toEqual([]);
    expect(one.counts).toEqual(compact.counts);
  });
  it('the default retrospective result is far smaller for 20 long re-dispatch instructions', async () => {
    const id = 'r1-b-big';
    x.db.batches.insert({ id, repo_id: 'r1', title: 'Big', branch: 'feature/big', base_branch: 'main', status: 'merged', note: null, history: null, mr_url: null, conflict_files: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:01:00.000Z', merged_at: '2026-01-01T00:01:00.000Z', merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null });
    for (let i = 0; i < 20; i++) x.db.signals.insert({ batch_id: id, bead_id: 'ov-1', kind: 'redispatch', text: `${i}:${'x'.repeat(1500)}` });
    const compact = (await call('batch_retrospective', { repo: 'r1', batch_id: id })).text.length;
    const full = (await call('batch_retrospective', { repo: 'r1', batch_id: id, full: true })).text.length;
    console.log(`[retrospective size] default=${compact} full=${full}`);
    expect(full).toBeGreaterThan(30_000);
    expect(compact).toBeLessThan(8_000);
  });
  it('spawn_worker with a tier returns the resolved harness, model and tier', async () => {
    x.store.add(x.repo.path, { id: 'ov-4', title: 'Fourth' });
    const s = await call('spawn_worker', { repo: 'r1', bead_id: 'ov-4', tier: 'chore' });
    expect(s.isError).toBe(false);
    expect(s.json).toMatchObject({ bead_id: 'ov-4', harness: 'codex', model: 'gpt-5.6-luna', tier: 'chore', batch_id: null });
    await call('interrupt_worker', { repo: 'r1', bead_id: 'ov-4' });
  });
  it('interrupt_worker records a stop by the orchestrator with its reason, not a failure', async () => {
    x.store.add(x.repo.path, { id: 'ov-3', title: 'Third' });
    const s = await call('spawn_worker', { repo: 'r1', bead_id: 'ov-3', harness: 'claude' });
    const sessionId = (s.json as { session_id: string }).session_id;
    x.fake.emit(x.sessions.handleOf(sessionId)!, { type: 'assistant_text', text: "I'll load the coding-discipline skill, then make the change." });
    const r = await call('interrupt_worker', { repo: 'r1', bead_id: 'ov-3', reason: 'the user asked to leave the batch as it is' });
    expect(r.json).toMatchObject({ interrupted: true, session_id: sessionId });
    await until(async () => (await x.store.show(x.repo.path, 'ov-3'))?.status === 'open' && x.db.sessions.get(sessionId)?.status !== 'running', 5000, 'reopened after interrupt_worker');
    expect(x.db.sessions.get(sessionId)?.status).toBe('ended');
    const notes = (await x.store.show(x.repo.path, 'ov-3'))?.notes ?? '';
    expect(notes).toContain('Stopped by the orchestrator: the user asked to leave the batch as it is');
    expect(notes).not.toContain('ended without new commits');
    expect((await call('interrupt_worker', { repo: 'r1', bead_id: 'ov-3' })).isError).toBe(true);
  });
});

describe('the Board refresh of a bd write', () => {
  // Counted on a driven clock: on the real one the five-write case fails whenever the calls spread past the window, and the
  // stream case passes whatever the scheduler does (fix round 23 review NB-2).
  it('submit_review is refused without a live critic, records the verdict of one, and accept_review lands a parked bead', async () => {
    x.store.add(x.repo.path, { id: 'ov-9', title: 'Reviewed', description: 'd9' });
    x.db.repos.update('r1', { review_rounds: 1 });
    try {
      expect(await call('submit_review', { repo: 'r1', bead_id: 'ov-9', verdict: 'pass' })).toMatchObject({ isError: true, text: expect.stringContaining('no critic session is reviewing ov-9') });
      expect(await call('accept_review', { repo: 'r1', bead_id: 'ov-9', note: 'n' })).toMatchObject({ isError: true, text: expect.stringContaining('no worktree for ov-9') });
      const { json } = await call('spawn_worker', { repo: 'r1', bead_id: 'ov-9', harness: 'claude' });
      commitFile(x.db.worktrees.get('ov-9')!.path, 'nine.txt', '9\n', 'nine');
      x.fake.emit(x.sessions.handleOf(json.session_id)!, { type: 'turn_end', nativeSessionId: 'n', cost: 0.1 });
      const critic = () => x.db.sessions.forBead('ov-9').find((s) => s.role === 'critic' && s.status === 'running');
      await until(() => !!critic(), 5000, 'critic');
      expect(critic()).toMatchObject({ harness: 'claude', model: 'fable', tier: 'critic' });
      // message_worker addresses the worker, never the critic that is the bead's latest session (final review M-2).
      expect(await call('message_worker', { repo: 'r1', bead_id: 'ov-9', text: 'hello?' })).toMatchObject({ isError: true, text: expect.stringContaining('worker for ov-9 is not running (status ended)') });
      expect(x.fake.sent(x.sessions.handleOf(critic()!.id)!)).not.toContain('hello?');
      const findings = [{ file: 'nine.txt', summary: 'Nine is not documented.', severity: 'must' }]; // a should-only round lands instead of parking
      expect((await call('submit_review', { repo: 'r1', bead_id: 'ov-9', verdict: 'findings', findings })).json).toEqual({ recorded: true });
      x.fake.emit(x.sessions.handleOf(critic()!.id)!, { type: 'turn_end', nativeSessionId: 'c', cost: 0.1 });
      await until(() => x.db.worktrees.get('ov-9')?.review_findings !== null, 5000, 'parked');
      expect(x.db.worktrees.get('ov-9')?.review_findings).toEqual(findings);
      expect((await call('accept_review', { repo: 'r1', bead_id: 'ov-9', note: 'Documented elsewhere.' })).json).toEqual({ landed: true, bead_id: 'ov-9' });
      expect(x.db.worktrees.get('ov-9')).toMatchObject({ accepted_note: 'Documented elsewhere.', review_findings: null, review_round: null });
      expect((await x.store.show(x.repo.path, 'ov-9'))?.labels).toContain('overseer:review');
    } finally {
      x.db.repos.update('r1', { review_rounds: 0 });
    }
  });

  it('costs one refresh for a burst, and a stream that never pauses still gets one within the cap', async () => {
    const bus = new Bus();
    const boards: string[] = [];
    const off = bus.on('board', () => boards.push('board'));
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) refreshBoard(bus);
      expect(boards).toEqual([]); // scheduled, not emitted in place: the write returns before any `bd list`
      await vi.advanceTimersByTimeAsync(BOARD_COALESCE_MS);
      expect(boards).toEqual(['board']); // five writes, one refresh: a refresh costs a `bd list` plus `bd ready` per repo
      await vi.advanceTimersByTimeAsync(BOARD_COALESCE_MS * 3);
      expect(boards).toEqual(['board']); // and nothing trails behind it
      // Writes that keep landing inside the window postpone the refresh, but never past BOARD_COALESCE_MAX_MS.
      boards.length = 0;
      const step = BOARD_COALESCE_MS - 150;
      for (let i = 0; i < 10; i++) { refreshBoard(bus); await vi.advanceTimersByTimeAsync(step); }
      expect(boards).toEqual(['board']);
      expect(step * 10).toBeGreaterThan(BOARD_COALESCE_MAX_MS); // the stream really did outlast the cap
    } finally {
      vi.useRealTimers();
      off();
    }
  });
  it('the parity tools call the lifecycle the Board and Review buttons call: merge and reject refuse a batch not in review, then reject, merge, abandon, close and retry verification', async () => {
    const dispatchAndLand = async (beadId: string, batchId?: string) => {
      x.store.add(x.repo.path, { id: beadId, title: beadId });
      const { json } = await call('spawn_worker', { repo: 'r1', bead_id: beadId, harness: 'claude', ...(batchId ? { batch_id: batchId } : {}) });
      commitFile(x.db.worktrees.get(beadId)!.path, `${beadId}.txt`, `${beadId}\n`, beadId);
      x.fake.emit(x.sessions.handleOf(json.session_id)!, { type: 'turn_end', nativeSessionId: 'n', cost: 0.1 });
      return json.session_id as string;
    };
    const batch = (await call('create_batch', { repo: 'r1', title: 'Parity' })).json.batch_id as string;
    expect(await call('merge_batch', { repo: 'r1', batch_id: batch })).toMatchObject({ isError: true, text: expect.stringContaining('not in review') });
    expect(await call('reject_batch', { repo: 'r1', batch_id: batch, note: 'n' })).toMatchObject({ isError: true, text: expect.stringContaining('not in review') });
    expect(await call('merge_batch', { repo: 'r1', batch_id: 'r1-b99' })).toMatchObject({ isError: true, text: expect.stringContaining('not found') });
    await dispatchAndLand('ov-20', batch);
    await until(() => !!x.db.worktrees.get('ov-20')?.merged_at, 5000, 'landed');
    expect((await call('request_batch_review', { repo: 'r1', batch_id: batch, note: 'ready' })).json).toMatchObject({ in_review: true });
    expect((await call('reject_batch', { repo: 'r1', batch_id: batch, note: 'not yet' })).json).toEqual({ rejected: true, batch_id: batch });
    expect(x.db.batches.get(batch)).toMatchObject({ status: 'open', history: expect.stringContaining('Rejected: not yet') });
    // close_bead: a never-dispatched bead of the batch, closed as won't do; the batch stays open.
    x.store.add(x.repo.path, { id: 'ov-21', title: 'Not wanted' });
    expect((await call('close_bead', { repo: 'r1', bead_id: 'ov-21', note: 'declined' })).json).toEqual({ closed: true, bead_id: 'ov-21' });
    expect((await x.store.show(x.repo.path, 'ov-21'))?.status).toBe('closed');
    expect(await call('close_bead', { repo: 'r1', bead_id: 'ov-21' })).toMatchObject({ isError: true, text: expect.stringContaining('already closed') });
    expect((await call('request_batch_review', { repo: 'r1', batch_id: batch, note: 'ready' })).json).toMatchObject({ in_review: true });
    expect((await call('merge_batch', { repo: 'r1', batch_id: batch })).json).toEqual({ merged: true, batch_id: batch, mr_url: null });
    expect(x.db.batches.get(batch)?.status).toBe('merged');
    // retry_verification: a reviewed bead without a batch keeps its worktree; the retry re-runs the (absent) verify command on it.
    await dispatchAndLand('ov-22');
    await until(async () => (await x.store.show(x.repo.path, 'ov-22'))?.labels.includes('overseer:review') ?? false, 5000, 'review');
    expect((await call('retry_verification', { repo: 'r1', bead_id: 'ov-22' })).json).toEqual({ verifying: true, bead_id: 'ov-22' });
    expect(x.db.worktrees.get('ov-22')).toMatchObject({ verify_status: 'pass' });
    expect(await call('retry_verification', { repo: 'r1', bead_id: 'ov-21' })).toMatchObject({ isError: true, text: expect.stringContaining('no worktree') });
    // abandon_batch: every bead of the batch closes with it.
    const doomed = (await call('create_batch', { repo: 'r1', title: 'Doomed' })).json.batch_id as string;
    x.store.add(x.repo.path, { id: 'ov-23', title: 'Never dispatched', labels: [`overseer:batch:${doomed}`] });
    expect((await call('abandon_batch', { repo: 'r1', batch_id: doomed })).json).toEqual({ abandoned: true, batch_id: doomed });
    expect(x.db.batches.get(doomed)?.status).toBe('abandoned');
    expect((await x.store.show(x.repo.path, 'ov-23'))?.status).toBe('closed');
    expect(await call('abandon_batch', { repo: 'r1', batch_id: doomed })).toMatchObject({ isError: true, text: expect.stringContaining('is abandoned') });
  });
});
