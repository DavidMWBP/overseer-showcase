import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { Push } from './push/push';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ActionResult, BoardResponse, HarnessName, TaskDetail, WsMessage } from '@overseer/shared';
import { openDb } from './db/db';
import { Bus } from './bus';
import { FakeAdapter } from './harness/fake';
import { SessionManager } from './sessions/manager';
import { MemoryTaskStore } from './beads/memory';
import { LocalMergeProvider } from './git/provider';
import { Lifecycle, batchWorktreePath } from './lifecycle/lifecycle';
import { Prober } from './lifecycle/probe';
import { Orchestrator } from './orchestrator/orchestrator';
import { Discussions } from './discussions/discussions';
import { loadConfig } from './config';
import { mkTmpRepo, copyTmpRepo, commitFile, sh } from './test/tmpgit';
import type { TmpRepo } from './test/tmpgit';
import { until } from './test/until';
import { buildApp } from './app';
import { ActionJobs } from './api/jobs';
import { waitForEvidenceRefreshForTests } from './api/evidence';
import { Servers } from './servers/servers';
import { Plans } from './plans/plans';
import { baseWorktreePath, ensureWorktree } from './git/git';
import { log } from './util/log';
import { listenWithRetry, relaunchDaemon, restartInputHash, takeOverPort, waitForRestartParent, waitForSuccessorReady } from './util/daemon';
import * as procs from './util/procs';
import type { LineProcess } from './util/procs';
import os from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountLogins } from './accounts/login';
import { AUTH_HOLD_UNTIL } from './accounts/status';
import { accountEnv } from './accounts/env';
import { accountUsable } from './accounts/usage';
import { OPENCODE_PERMISSION, opencodeArgs } from './harness/opencode';

let app: FastifyInstance;
let x: ReturnType<typeof setup>;
let plans: Plans;
let daemon: { pid: number; startedAt: string; commit: string | null; sourceRoot: string; sourceHead: () => Promise<string | null>; relaunch: () => Promise<void>; restarting: boolean; restartFailure?: { reason: string; output: string[] } | null };
let testDataDir: string;
let initialDataDir: string;
// One committed repository copied per test: every copy is isolated, without repeating git init and the first commit.
let template: TmpRepo;
const isolatedChatApps: { app: FastifyInstance; fixture: ReturnType<typeof setup> }[] = [];

function setup(opts: { usageGate?: typeof accountUsable } = {}) {
  const t = mkTmpRepo();
  fs.mkdirSync(path.join(t.path, '.beads'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-data-'));
  const db = openDb(':memory:');
  const bus = new Bus();
  const fake = new FakeAdapter();
  const sessions = new SessionManager(db, { claude: fake, codex: new FakeAdapter('codex') }, bus, path.join(dataDir, 'sessions'));
  const store = new MemoryTaskStore();
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: t.worktreesDir, orchestratorDir: path.join(path.dirname(t.worktreesDir), 'orch') };
  const orchestrator = new Orchestrator({ db, sessions, bus, config, usageGate: opts.usageGate });
  const lifecycle = new Lifecycle({ db, store, sessions, bus, config, usageGate: async () => ({ usable: true }), provider: () => new LocalMergeProvider(), notify: (m, o) => orchestrator.systemMessage(m, o) });
  const servers = new Servers(db, path.join(dataDir, 'servers'));
  const prober = new Prober({ db, bus, worktreesDir: config.worktreesDir, notify: async () => {} });
  const discussions = new Discussions({ db, sessions, bus, config });
  return { t, db, bus, fake, sessions, store, config, orchestrator, lifecycle, servers, prober, discussions };
}

function buildTestApp(fixture: ReturnType<typeof setup>, existingPlans?: Plans): FastifyInstance {
  const testPlans = existingPlans ?? new Plans({ db: fixture.db, store: fixture.store, lifecycle: fixture.lifecycle, bus: fixture.bus, notify: async () => {} });
  return buildApp({ db: fixture.db, bus: fixture.bus, store: fixture.store, sessions: fixture.sessions, lifecycle: fixture.lifecycle, orchestrator: fixture.orchestrator, config: fixture.config, push: new Push(fixture.db, async () => undefined), daemon, logins: new AccountLogins(fixture.db, fixture.config), doctorRunner: async (bin) => ({ code: 0, stdout: `${bin} 1.0.0`, stderr: '' }), plans: testPlans, discussions: fixture.discussions, servers: fixture.servers, prober: fixture.prober, jobs: new ActionJobs(fixture.bus) });
}

beforeAll(async () => {
  x = setup();
  template = mkTmpRepo();
  initialDataDir = x.config.dataDir;
  expect(x.config.dataDir).not.toBe(loadConfig({}).dataDir);
  daemon = { pid: 1234, startedAt: '2026-09-15T00:00:00.000Z', commit: 'old', sourceRoot: '/overseer/main', sourceHead: async () => 'new', relaunch: async () => undefined, restarting: false };
  plans = new Plans({ db: x.db, store: x.store, lifecycle: x.lifecycle, bus: x.bus, notify: async () => {} });
  app = buildTestApp(x, plans);
  await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
  fs.rmSync(template.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(initialDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
beforeEach(() => {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-data-'));
  x.config.dataDir = testDataDir;
  x.config.orchestratorDir = path.join(testDataDir, 'orch');
});
afterEach(async () => {
  for (const isolated of isolatedChatApps.splice(0)) {
    await isolated.app.close();
    fs.rmSync(isolated.fixture.t.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.rmSync(isolated.fixture.config.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const json = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: object) => {
  const r = await app.inject({ method, url, payload: body });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

/** POST an action endpoint and, when it answers 202, wait for its background job's result. Subscribes first: a fast job can finish before `inject` returns. */
const runAction = async (url: string, body?: object): Promise<{ status: number; body: unknown; result: ActionResult | null }> => {
  const seen: ActionResult[] = [];
  const off = x.bus.on('action_result', (a) => seen.push(a));
  try {
    const r = await json('POST', url, body);
    if (r.status !== 202) return { ...r, result: null };
    const job_id = (r.body as { job_id: string }).job_id;
    const before = seen.find((a) => a.job_id === job_id);
    if (before) return { status: r.status, body: r.body, result: before };
    const result = await new Promise<ActionResult>((resolve) => {
      const off2 = x.bus.on('action_result', (a) => { if (a.job_id === job_id) { off2(); resolve(a); } });
    });
    return { status: r.status, body: r.body, result };
  } finally { off(); }
};

function stubBin(name: string, source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `overseer-${name}-`));
  fs.writeFileSync(path.join(dir, 'target.js'), source);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@ECHO off\r\nSET dp0=%~dp0\r\n"${process.execPath}" "%dp0%\\target.js" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/target.js" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe('REST', () => {
  it('opens an evidence folder with a long Windows-safe name in the app', async () => {
    const fixture = setup();
    const testApp = buildTestApp(fixture);
    const name = `long-${'x'.repeat(160)}`;
    const evidenceDir = path.join(fixture.config.dataDir, 'evidence');
    fs.mkdirSync(path.join(evidenceDir, name), { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, name, 'entry.txt'), 'long');
    try {
      await testApp.ready();
      const list = await testApp.inject({ method: 'GET', url: '/api/evidence' });
      const page = await testApp.inject({ method: 'GET', url: `/api/evidence/${encodeURIComponent(name)}?offset=0&limit=100` });
      const folder = JSON.parse(list.body).find((entry: { name: string }) => entry.name === name);
      expect({ folder, status: page.statusCode, files: JSON.parse(page.body).files.map((file: { relative_path: string }) => file.relative_path) }).toEqual({
        folder: { name, file_count: 1, total_size: 4, modified_at: expect.any(String) }, status: 200, files: ['entry.txt'],
      });
    } finally {
      await waitForEvidenceRefreshForTests(evidenceDir);
      await testApp.close();
      fixture.db.sql.close();
      fs.rmSync(fixture.t.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      fs.rmSync(fixture.config.dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('answers after storage when user delivery finishes before the response is written', async () => {
    const fixture = setup({ usageGate: async () => ({ usable: true }) });
    fixture.config.orchestratorDir = path.join(fixture.config.dataDir, 'orch');
    const testApp = buildTestApp(fixture);
    isolatedChatApps.push({ app: testApp, fixture });
    let release!: () => void;
    let held = true;
    const responseGate = new Promise<void>((resolve) => { release = resolve; });
    testApp.addHook('onSend', async (request, _reply, payload) => {
      if (request.method === 'POST' && request.url === '/api/chat' && held) {
        held = false;
        await responseGate;
      }
      return payload;
    });
    await testApp.ready();
    const send = vi.spyOn(fixture.orchestrator, 'sendUser');
    const events: string[] = [];
    const off = fixture.bus.on('chat', () => events.push('chat'));
    const request = testApp.inject({ method: 'POST', url: '/api/chat', payload: { text: 'fast delivery' } });

    try {
      await until(() => send.mock.results.length === 1);
      const delivery = send.mock.results[0]!.value as Promise<void>;
      await delivery;
      events.push('delivery');
      expect(fixture.db.chat.all().at(-1)).toMatchObject({ role: 'user', kind: 'message', text: 'fast delivery' });
      expect(events).toContain('chat');

      release();
      const response = await request;
      events.push('response');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(events.indexOf('delivery')).toBeLessThan(events.indexOf('response'));
    } finally {
      release();
      await request.catch(() => undefined);
      await Promise.all(send.mock.results.map((result) => result.type === 'return' ? result.value as Promise<void> : Promise.resolve()));
      off();
      send.mockRestore();
    }
  });

  it('answers two posts while a cold delivery is blocked and later delivers them in order', async () => {
    const fixture = setup({ usageGate: async () => ({ usable: true }) });
    fixture.config.orchestratorDir = path.join(fixture.config.dataDir, 'orch');
    const testApp = buildTestApp(fixture);
    isolatedChatApps.push({ app: testApp, fixture });
    await testApp.ready();
    const accountId = 'chat-post-refresh';
    fixture.db.accounts.insert({ id: accountId, name: 'Chat POST', harness: 'claude', kind: 'oauth_token', secret: 'expired-access', refresh_token: 'refresh-token', token_expires_at: Date.now() - 1, home: null, created_at: 'test', last_login_at: 'test', last_verified_at: null });
    fixture.db.settings.set('orchestrator', { ...fixture.db.settings.orchestrator(), account: accountId });
    expect(fixture.config.dataDir).not.toBe(loadConfig({}).dataDir);
    expect(fixture.config.port).not.toBe(4400);
    let completeRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { completeRefresh = resolve; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(refresh);
    const start = vi.spyOn(fixture.sessions, 'start');
    const send = vi.spyOn(fixture.orchestrator, 'sendUser');
    let chatEvents = 0;
    const off = fixture.bus.on('chat', () => chatEvents++);
    let refreshFinished = false;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

    try {
      const first = await testApp.inject({ method: 'POST', url: '/api/chat', payload: { text: 'first cold send', attachments: [{ name: 'tiny.png', mime: 'image/png', data: png.toString('base64') }] } });
      expect({ status: first.statusCode, body: first.json() }).toEqual({ status: 200, body: { ok: true } });
      await until(() => fetchSpy.mock.calls.length === 1);
      const firstRow = fixture.db.chat.all().find((row) => row.text === 'first cold send')!;
      expect(firstRow).toMatchObject({ role: 'user', kind: 'message', attachments: [{ name: 'tiny.png', mime: 'image/png', size: png.length }] });
      expect(fs.readFileSync(fixture.db.chat.attachment(firstRow.id, 0)!.path)).toEqual(png);

      const second = await testApp.inject({ method: 'POST', url: '/api/chat', payload: { text: 'second cold send' } });
      expect({ status: second.statusCode, body: second.json() }).toEqual({ status: 200, body: { ok: true } });
      expect(fixture.db.chat.all().filter((row) => row.role === 'user').slice(-2).map((row) => row.text)).toEqual(['first cold send', 'second cold send']);
      expect(chatEvents).toBe(2);
      expect(start).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      completeRefresh(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-token', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }));
      refreshFinished = true;
      await Promise.all(send.mock.results.map((result) => result.type === 'return' ? result.value as Promise<void> : Promise.resolve()));

      expect(start).toHaveBeenCalledTimes(1);
      const session = fixture.db.sessions.latest('orchestrator')!;
      const delivered = fixture.fake.sent(fixture.sessions.handleOf(session.id)!);
      const firstIndex = delivered.findIndex((text) => text.includes(`first cold send\n\n[attached image: ${fixture.db.chat.attachment(firstRow.id, 0)!.path}]`));
      const secondIndex = delivered.findIndex((text) => text === 'second cold send');
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
    } finally {
      if (!refreshFinished) completeRefresh(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'rotated-token', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }));
      await Promise.all(send.mock.results.map((result) => result.type === 'return' ? result.value as Promise<void> : Promise.resolve()));
      off();
      send.mockRestore();
      start.mockRestore();
      fetchSpy.mockRestore();
      fixture.db.accounts.remove(accountId);
    }
  });

  it('retries an undelivered message once: answers while the delivery is queued, refuses a second retry and non-failure rows', async () => {
    // The usage gate is the slow boundary: it refuses the first send, then holds the retried delivery until released.
    let gate: Promise<{ usable: true }> | null = null;
    let release!: () => void;
    const fixture = setup({ usageGate: async () => gate ?? { usable: false as const, reason: 'account Chat retry: session 95% >= 95%' } });
    fixture.config.orchestratorDir = path.join(fixture.config.dataDir, 'orch');
    const testApp = buildTestApp(fixture);
    isolatedChatApps.push({ app: testApp, fixture });
    await testApp.ready();
    expect(fixture.config.dataDir).not.toBe(loadConfig({}).dataDir);
    expect(fixture.config.port).not.toBe(4400);
    fixture.db.accounts.insert({ id: 'chat-retry', name: 'Chat retry', harness: 'claude', kind: 'oauth_token', secret: 'access', refresh_token: 'refresh', token_expires_at: Date.now() + 3 * 60 * 60_000, home: null, created_at: 'test', last_login_at: 'test', last_verified_at: null });
    fixture.db.settings.set('orchestrator', { ...fixture.db.settings.orchestrator(), account: 'chat-retry' });
    const retry = vi.spyOn(fixture.orchestrator, 'retryUser');
    try {
      await testApp.inject({ method: 'POST', url: '/api/chat', payload: { text: 'send me', repo: 'web' } });
      await until(() => fixture.db.chat.all().some((row) => row.failed_for !== null));
      const page = (await testApp.inject({ method: 'GET', url: '/api/chat' })).json() as { rows: { id: number; role: string; text: string; failed_for: number | null; retried_at: string | null }[] };
      const user = page.rows.find((row) => row.role === 'user')!;
      expect(user.text).toBe('[repo: web] send me');
      const failure = page.rows.find((row) => row.failed_for === user.id)!;
      expect(failure).toMatchObject({ role: 'system', retried_at: null });

      gate = new Promise((resolve) => { release = () => resolve({ usable: true }); });
      const accepted = await testApp.inject({ method: 'POST', url: `/api/chat/${failure.id}/retry` });
      expect({ status: accepted.statusCode, body: accepted.json() }).toEqual({ status: 200, body: { ok: true } });
      expect(fixture.db.sessions.latest('orchestrator')).toBeUndefined();
      const again = await testApp.inject({ method: 'POST', url: `/api/chat/${failure.id}/retry` });
      expect(again.statusCode).toBe(409);
      expect((await testApp.inject({ method: 'POST', url: `/api/chat/${user.id}/retry` })).statusCode).toBe(404);
      expect((await testApp.inject({ method: 'POST', url: '/api/chat/999999/retry' })).statusCode).toBe(404);
      const reloaded = (await testApp.inject({ method: 'GET', url: '/api/chat' })).json() as { rows: { id: number; retried_at: string | null }[] };
      expect(reloaded.rows.find((row) => row.id === failure.id)!.retried_at).toBeTruthy();

      release();
      await retry.mock.results[0]!.value;
      const session = fixture.db.sessions.latest('orchestrator')!;
      expect(fixture.fake.sent(fixture.sessions.handleOf(session.id)!)[0]!.endsWith('\n\n[repo: web] send me')).toBe(true);
      expect(fixture.db.chat.all().filter((row) => row.role === 'user')).toHaveLength(1);
    } finally {
      release?.();
      await Promise.all(retry.mock.results.map((result) => result.type === 'return' ? result.value as Promise<void> : Promise.resolve()));
      retry.mockRestore();
      fixture.db.accounts.remove('chat-retry');
    }
  });

  it('maps OpenCode provider API keys without changing Claude or Codex environments', () => {
    const base = { id: 'a1', name: 'A', secret: null, home: null, created_at: '', last_login_at: null, last_verified_at: null };

    expect(accountEnv({ ...base, harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'deepseek-key' })).toStrictEqual({ DEEPSEEK_API_KEY: 'deepseek-key' });
    expect(() => accountEnv({ ...base, harness: 'opencode', kind: 'api_key', provider: 'unknown', secret: 'key' })).toThrow('unknown OpenCode provider: unknown');
    expect(accountEnv({ ...base, harness: 'claude', kind: 'api_key', secret: 'claude-key' })).toStrictEqual({ ANTHROPIC_API_KEY: 'claude-key', CLAUDE_CODE_OAUTH_TOKEN: undefined });
    expect(accountEnv({ ...base, harness: 'codex', kind: 'codex_home', home: 'C:/accounts/a1' })).toStrictEqual({ CODEX_HOME: 'C:/accounts/a1' });
  });

  it('verifies an OpenCode account with the worker command line and environment, through a .cmd-style stand-in', async () => {
    // Like `opencode run`, the stand-in reads piped stdin to EOF first: Verify left stdin open, so it hung until the
    // 20-second timeout and reported "exited with code -1".
    const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-oc-record-')), 'record.json');
    const bin = stubBin('opencode', `process.stdin.resume(); process.stdin.on('end', () => {
      require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), permission: process.env.OPENCODE_PERMISSION ?? null, key: process.env.DEEPSEEK_API_KEY ?? null }));
      console.log('{"type":"text","part":{"type":"text","text":"ok"}}');
    });`);
    const originalBin = x.config.opencodeBin;
    x.config.opencodeBin = bin;
    const account = await json('POST', '/api/accounts', { name: 'Verify DeepSeek', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'verify-key' });
    try {
      expect(await json('POST', `/api/accounts/${account.body.id}/verify`, {})).toEqual({ status: 200, body: { ok: true } });
      const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { args: string[]; permission: string | null; key: string | null };
      const model = seen.args.includes('--model') ? seen.args[seen.args.indexOf('--model') + 1] : undefined;
      expect(seen.args).toEqual(opencodeArgs(seen.args[4]!, null, { model }));
      expect(seen.args.slice(0, 4)).toEqual(['run', '--format', 'json', '--dir']);
      expect(seen.args).not.toContain('--auto');
      expect(seen.permission).toBe(OPENCODE_PERMISSION);
      expect(seen.key).toBe('verify-key');
    } finally {
      x.config.opencodeBin = originalBin;
      await json('DELETE', `/api/accounts/${account.body.id}`);
      fs.rmSync(path.dirname(record), { recursive: true, force: true });
      fs.rmSync(path.dirname(bin), { recursive: true, force: true });
    }
  }, 30_000);

  it('returns cached Claude OAuth account usage', async () => {
    x.db.accounts.insert({ id: 'usage-rest', name: 'Usage', harness: 'claude', kind: 'oauth_token', secret: 'usage-token', home: null, created_at: 't', last_login_at: 't', last_verified_at: null });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ limits: [{ percent: 42, resets_at: 'later', scope: 'five_hour' }] }), { status: 200 }));
    try {
      expect(await json('GET', '/api/accounts/usage-rest/usage')).toMatchObject({ status: 200, body: { session: { percent: 42, resetsAt: 'later' }, weekly: null, models: [] } });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore(); x.db.accounts.remove('usage-rest');
    }
  });

  it('reports daemon startup facts and restart need from the current source head', async () => {
    expect(await json('GET', '/api/daemon')).toEqual({ status: 200, body: { pid: 1234, started_at: '2026-09-15T00:00:00.000Z', commit: 'old', source_head: 'new', restart_needed: true, restart_in_progress: false, restart_failure: null, data_dir: x.config.dataDir, source_root: '/overseer/main' } });
    daemon.commit = null;
    expect((await json('GET', '/api/daemon')).body.restart_needed).toBe(false);
    daemon.commit = 'old';
  });

  it('acknowledges one daemon restart and refuses another while it is pending', async () => {
    const relaunch = vi.fn(async () => undefined);
    daemon.relaunch = relaunch;
    daemon.restarting = false;
    expect(await json('POST', '/api/daemon/restart')).toEqual({ status: 202, body: { ok: true, pid: 1234 } });
    expect((await json('POST', '/api/daemon/restart')).status).toBe(409);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaunch).toHaveBeenCalledOnce();
    daemon.relaunch = async () => undefined;
    daemon.restarting = false;
  });

  it('records a failed dependency install and sends one wake notice while keeping the daemon online', async () => {
    const sourceRoot = path.join(testDataDir, 'checkout');
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"test"}\n');
    fs.writeFileSync(path.join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    fs.mkdirSync(path.join(sourceRoot, 'packages', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'packages', 'fixture', 'package.json'), '{"name":"@test/fixture"}\n');
    const startupInputHash = restartInputHash(sourceRoot);
    fs.appendFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), 'changed: true\n');
    const output = Array.from({ length: 22 }, (_, index) => `install output ${index + 1}`).join('\n');
    const installRunner = vi.fn(async () => ({ code: 7, output, timedOut: false }));
    const spawnSuccessor = vi.fn();
    const originalRelaunch = daemon.relaunch;
    daemon.restarting = false;
    daemon.restartFailure = null;
    daemon.relaunch = () => relaunchDaemon(app, testDataDir, { sourceRoot, startupInputHash, installRunner, spawn: spawnSuccessor as never });
    const notice = vi.spyOn(x.orchestrator, 'systemMessage').mockResolvedValue();
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      expect(await json('POST', '/api/daemon/restart')).toMatchObject({ status: 202 });
      await until(() => !daemon.restarting, 5_000, 'restart install failure');
      const status = await json('GET', '/api/daemon');
      expect({
        installCalls: installRunner.mock.calls.length,
        spawned: spawnSuccessor.mock.calls.length,
        status: { inProgress: status.body.restart_in_progress, failure: status.body.restart_failure },
        notices: notice.mock.calls.map(([message, options]) => ({ message, wake: options?.wake })),
      }).toEqual({
        installCalls: 1,
        spawned: 0,
        status: {
          inProgress: false,
          failure: {
            reason: 'pnpm install --frozen-lockfile exited with code 7',
            output: Array.from({ length: 20 }, (_, index) => `install output ${index + 3}`),
          },
        },
        notices: [{ message: 'Daemon restart failed: pnpm install --frozen-lockfile exited with code 7', wake: true }],
      });
    } finally {
      daemon.relaunch = originalRelaunch;
      daemon.restarting = false;
      daemon.restartFailure = null;
      notice.mockRestore();
      logError.mockRestore();
    }
  });

  it('clears a recorded failure after a successful restart', async () => {
    const originalRelaunch = daemon.relaunch;
    const originalPid = daemon.pid;
    daemon.restarting = false;
    daemon.restartFailure = { reason: 'previous failure', output: ['old output'] };
    daemon.relaunch = async () => { daemon.pid = 5678; };
    try {
      expect(await json('POST', '/api/daemon/restart')).toMatchObject({ status: 202 });
      await until(() => !daemon.restarting, 5_000, 'successful restart');
      const status = await json('GET', '/api/daemon');
      expect({ pid: status.body.pid, inProgress: status.body.restart_in_progress, failure: status.body.restart_failure }).toEqual({ pid: 5678, inProgress: false, failure: null });
    } finally {
      daemon.relaunch = originalRelaunch;
      daemon.pid = originalPid;
      daemon.restarting = false;
      daemon.restartFailure = null;
    }
  });

  it('allows retrying when the successor cannot be started', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notice = vi.spyOn(x.orchestrator, 'systemMessage').mockResolvedValue();
    daemon.relaunch = vi.fn(async () => { throw new Error('spawn failed'); });
    daemon.restarting = false;
    try {
      expect((await json('POST', '/api/daemon/restart')).status).toBe(202);
      await until(() => !daemon.restarting, 5_000, 'first restart failure');
      expect(daemon.restarting).toBe(false);
      expect((await json('POST', '/api/daemon/restart')).status).toBe(202);
      await until(() => !daemon.restarting, 5_000, 'second restart failure');
      expect(notice).toHaveBeenCalledTimes(2);
    } finally {
      await until(() => !daemon.restarting, 5_000, 'restart cleanup');
      error.mockRestore();
      notice.mockRestore();
      daemon.relaunch = async () => undefined;
      daemon.restarting = false;
      daemon.restartFailure = null;
    }
  });

  it('registers a repo with defaults and rejects non-repos', async () => {
    const bad = await json('POST', '/api/repos', { path: path.join(x.t.path, 'nope') });
    expect(bad.status).toBe(400);
    const r = await json('POST', '/api/repos', { path: x.t.path, id: 'r1', verify_command: 'node -e 0' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'r1', path: x.t.path, base_branch: 'main', merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_command: null });
    expect((await json('GET', '/api/repos')).body).toHaveLength(1);
    const other = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: other.path, id: 'r1' })).status).toBe(409);
  });
  it('offers the orchestrator approver only for local-merge and refuses it for a GitLab repository', async () => {
    const t = mkTmpRepo();
    // A gitlab-mr repository always approves with the user: the orchestrator never merges a merge request on its own.
    const bad = await json('POST', '/api/repos', { path: t.path, id: 'git-bad', merge_mode: 'gitlab-mr', batch_approver: 'orchestrator' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'a gitlab-mr repository always approves with the user: the orchestrator never merges a merge request on its own' });
    expect(x.db.repos.get('git-bad')).toBeUndefined();
    // The orchestrator value is accepted for local-merge.
    const ok = await json('POST', '/api/repos', { path: t.path, id: 'self-t', merge_mode: 'local-merge', batch_approver: 'orchestrator' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: 'self-t', merge_mode: 'local-merge', batch_approver: 'orchestrator' });
    // The patch is validated against the state it leaves behind: flipping to gitlab-mr alone is refused, and the same patch
    // that also returns the approver to user is accepted.
    const refused = await json('PATCH', '/api/repos/self-t', { merge_mode: 'gitlab-mr' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: 'a gitlab-mr repository always approves with the user: the orchestrator never merges a merge request on its own' });
    expect(x.db.repos.get('self-t')).toMatchObject({ merge_mode: 'local-merge', batch_approver: 'orchestrator' });
    expect((await json('PATCH', '/api/repos/self-t', { merge_mode: 'gitlab-mr', batch_approver: 'user' })).status).toBe(200);
    expect(x.db.repos.get('self-t')).toMatchObject({ merge_mode: 'gitlab-mr', batch_approver: 'user' });
    // The db is shared by the whole file, so a repository left behind reaches later routes (the costs list, the board build count).
    x.db.repos.delete('self-t');
  });
  it('board, status, task detail, chat and answer', async () => {
    x.store.add(x.t.path, { id: 'ov-1', title: 'Hello task', description: 'say hi' });
    const board = (await json('GET', '/api/board')).body as BoardResponse;
    expect(board.bd_ok).toBe(true);
    expect(board.repos[0]!.cards[0]).toMatchObject({ column: 'ready', bead: { id: 'ov-1' } });
    expect((await json('GET', '/api/status')).body).toEqual({ bd_ok: true, orchestrator: { status: 'idle', native_session_id: null, last_activity_at: null, busy: false, model: null, context: null } });
    expect((await json('GET', '/api/tasks/ov-9')).status).toBe(404);
    const detail = (await json('GET', '/api/tasks/ov-1')).body as TaskDetail;
    expect(detail).toMatchObject({ bead: { id: 'ov-1' }, repo: { id: 'r1' }, sessions: [], worktree: null, diff: null });

    expect((await json('POST', '/api/chat', { text: 'do the hello task', repo: 'r1' })).status).toBe(200);
    const userRow = x.db.chat.all().find((row) => row.role === 'user' && row.text.endsWith('do the hello task'))!;
    await until(() => x.db.chat.get(userRow.id)?.seen_at !== null);
    const orch = x.db.sessions.latest('orchestrator')!;
    const h = x.sessions.handleOf(orch.id)!;
    expect(x.fake.sent(h)[0]!.endsWith('[repo: r1] do the hello task')).toBe(true);
    const q = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Which?' });
    expect((await json('POST', '/api/chat/answer', { question_id: 999, text: 'x' })).status).toBe(404);
    expect((await json('POST', '/api/chat/answer', { question_id: q.id, text: 'the first' })).status).toBe(200);
    const q2 = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'Still there?' });
    expect((await json('POST', '/api/chat/dismiss', { question_id: 999 })).status).toBe(404);
    expect((await json('POST', '/api/chat/dismiss', { question_id: q2.id })).status).toBe(200);
    expect(x.db.chat.get(q2.id)?.superseded_at).toBeTruthy();
    // The orchestrator hears about the dismissal, so its "waiting on your answer" does not stand as the last word (round 7).
    expect(x.fake.sent(h).at(-1)).toBe(`[Overseer] Question "Still there?" dismissed by the user without an answer. (question #${q2.id}; do not wait for an answer.)`);
    // The thread row carries neither the internal id nor the instruction (round 8).
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'system', text: 'Question "Still there?" dismissed by the user without an answer.' });
    expect(x.db.chat.all().at(-1)).not.toHaveProperty('hint');
    expect(x.db.chat.pendingQuestions()).toHaveLength(0);
    const chat = (await json('GET', '/api/chat')).body as { rows: { id: number; answer: string | null }[] };
    expect(chat.rows.find((c) => c.id === q.id)?.answer).toBe('the first');
  });
  it('pages chat history and validates its cursors (overseer-394)', async () => {
    const first = x.db.chat.insert({ role: 'user', kind: 'message', text: 'page 0' });
    const rows = Array.from({ length: 501 }, (_, i) => x.db.chat.insert({ role: i === 500 ? 'assistant' : 'user', kind: 'message', text: `page ${i + 1}`, ...(i === 500 ? { reply_to: first.id } : {}) }));

    const current = await json('GET', '/api/chat');
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ has_more: true, oldest_id: rows[401]!.id });
    expect(current.body.rows).toHaveLength(101); // The oldest reply target is included with the 100-row page.
    expect(current.body.rows.slice(-100).map((row: { id: number }) => row.id)).toEqual(rows.slice(401).map((row) => row.id));
    expect(current.body.rows[0]).toMatchObject({ id: first.id, text: 'page 0' });

    const previous = await json('GET', `/api/chat?before=${rows[401]!.id}&limit=500`);
    expect(previous.status).toBe(200);
    expect(previous.body.has_more).toBe(false);
    expect(previous.body.rows.slice(-401).map((row: { id: number }) => row.id)).toEqual(rows.slice(0, 401).map((row) => row.id));

    const since = await json('GET', `/api/chat?since=${rows[498]!.id}&limit=1`);
    expect(since.status).toBe(200);
    expect(since.body.rows.map((row: { id: number }) => row.id)).toEqual([rows[499]!, rows[500]!, first].map((row) => row.id).sort((a, b) => a - b));

    // Open questions and queued rows older than the window ride along on every page; an answered question drops off.
    const old_question = x.db.chat.insert({ role: 'assistant', kind: 'question', text: 'old question' });
    const old_queued = x.db.chat.insert({ role: 'system', kind: 'message', text: 'old queued', queued: true });
    for (let i = 0; i < 100; i++) x.db.chat.insert({ role: 'user', kind: 'message', text: `later ${i}` });
    const withOld = await json('GET', '/api/chat');
    expect(withOld.body.oldest_id).toBeGreaterThan(old_queued.id);
    expect(withOld.body.rows.slice(0, 2).map((row: { id: number }) => row.id)).toEqual([old_question.id, old_queued.id]);
    x.db.chat.answer(old_question.id, 'done');
    const answered = await json('GET', '/api/chat');
    expect(answered.body.rows.map((row: { id: number }) => row.id)).not.toContain(old_question.id);
    expect(answered.body.rows[0]).toMatchObject({ id: old_queued.id, text: 'old queued' });
    x.db.chat.flushQueued(); // the tests share one daemon: a leftover queued row would change the next orchestrator delivery
    expect((await json('GET', '/api/chat')).body.rows.map((row: { id: number }) => row.id)).not.toContain(old_queued.id);

    const clamped = await json('GET', '/api/chat?limit=999');
    expect(clamped.status).toBe(200);
    expect(clamped.body.rows).toHaveLength(501);
    for (const url of ['/api/chat?limit=zero', '/api/chat?limit=0', '/api/chat?before=1.5', '/api/chat?before=1&since=2']) expect((await json('GET', url)).status).toBe(400);
  });
  it('returns seen_at and replied_at on the chat page', async () => {
    const marked = x.db.chat.insert({ role: 'user', kind: 'message', text: 'status me' });
    x.db.chat.markSeen([marked.id]);
    x.db.chat.markReplied([marked.id]);
    const fresh = x.db.chat.insert({ role: 'user', kind: 'message', text: 'no status yet' });
    const page = (await json('GET', '/api/chat')).body as { rows: { id: number; seen_at: string | null; replied_at: string | null }[] };
    const row = page.rows.find((r) => r.id === marked.id)!;
    expect(row.seen_at).toBeTruthy();
    expect(row.replied_at).toBeTruthy();
    const untouched = page.rows.find((r) => r.id === fresh.id)!;
    expect(untouched.seen_at).toBeNull();
    expect(untouched.replied_at).toBeNull();
  });
  it('accepts, stores, serves and rejects chat attachments (overseer-5nh)', async () => {
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const post = await json('POST', '/api/chat', { text: 'a screenshot', attachments: [{ name: 'a.png', mime: 'image/png', data: png1x1.toString('base64') }] });
    expect(post.status).toBe(200);
    const row = x.db.chat.all().at(-1)!;
    expect(row.text).toBe('a screenshot');
    expect(row.attachments).toEqual([{ name: 'a.png', mime: 'image/png', size: png1x1.length }]);
    expect((row.attachments as unknown as { path?: string }[])[0]).not.toHaveProperty('path');
    const stored = x.db.chat.attachment(row.id, 0)!;
    expect(fs.existsSync(stored.path)).toBe(true);
    expect(fs.readFileSync(stored.path)).toEqual(png1x1);
    await until(() => x.db.chat.get(row.id)?.seen_at !== null);
    const h = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    expect(x.fake.sent(h).at(-1)).toBe(`a screenshot\n\n[attached image: ${stored.path}]`);

    const got = await app.inject({ method: 'GET', url: `/api/chat/${row.id}/attachments/0` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(got.rawPayload)).toEqual(png1x1);
    expect((await app.inject({ method: 'GET', url: `/api/chat/${row.id}/attachments/9` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/chat/999999/attachments/0' })).statusCode).toBe(404);

    expect((await json('POST', '/api/chat', { text: '' })).status).toBe(400);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, mime: 'image/png' as const, data: png1x1.toString('base64') }));
    expect((await json('POST', '/api/chat', { text: 'x', attachments: five })).status).toBe(400);
    const tooBig = { name: 'big.png', mime: 'image/png' as const, data: Buffer.alloc(9 * 1024 * 1024).toString('base64') };
    expect((await json('POST', '/api/chat', { text: 'x', attachments: [tooBig] })).status).toBe(400);
    expect((await json('POST', '/api/chat', { text: 'x', attachments: [{ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }] })).status).toBe(400);
    const prefixed = await json('POST', '/api/chat', { text: 'x', attachments: [{ name: 'a.png', mime: 'image/png', data: 'data:image/png;base64,aGk=' }] });
    expect(prefixed).toMatchObject({ status: 400, body: { error: expect.stringContaining('raw base64') } });
    const malformed = await json('POST', '/api/chat', { text: 'x', attachments: [{ name: 'a.png', mime: 'image/png', data: 'not-base64' }] });
    expect(malformed).toMatchObject({ status: 400, body: { error: expect.stringContaining('raw base64') } });
    fs.rmSync(x.config.orchestratorDir, { recursive: true, force: true });
  });
  it('stores rejection attachments on task and batch notices and rejects bad data before changing state', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const reviewTask = async (id: string) => {
      x.store.add(x.t.path, { id, title: id });
      const wt = await ensureWorktree(x.db.repos.get('r1')!, id, x.config.worktreesDir);
      x.db.worktrees.upsert({ bead_id: id, repo_id: 'r1', path: wt.path, branch: wt.branch, base_branch: 'main', verify_status: 'pass', verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null, review_round: null, review_findings: null, accepted_note: null });
      await x.store.update(x.t.path, id, { phase: 'review' });
    };

    await reviewTask('ov-reject-bad');
    const before = x.db.chat.all().length;
    const bad = await json('POST', '/api/tasks/ov-reject-bad/reject', { note: 'bad proof', attachments: [{ name: 'bad.png', mime: 'image/png', data: 'not-base64' }] });
    expect(bad).toMatchObject({ status: 400, body: { error: expect.stringContaining('raw base64') } });
    expect((await x.store.show(x.t.path, 'ov-reject-bad'))?.labels).toContain('overseer:review');
    expect(x.db.chat.all()).toHaveLength(before);

    await reviewTask('ov-reject');
    const rejected = await runAction('/api/tasks/ov-reject/reject', { note: 'see proof', attachments: [{ name: 'proof.png', mime: 'image/png', data: png.toString('base64') }] });
    expect(rejected).toMatchObject({ status: 202, result: { action: 'reject', ok: true } });
    const taskRow = x.db.chat.all().at(-1)!;
    const taskStored = x.db.chat.attachment(taskRow.id, 0)!;
    expect(taskRow).toMatchObject({ role: 'system', attachments: [{ name: 'proof.png', mime: 'image/png', size: png.length }] });
    expect(fs.readFileSync(taskStored.path)).toEqual(png);
    expect((await x.store.show(x.t.path, 'ov-reject'))?.notes).toContain(`Attachment: ${taskStored.path}`);
    const handle = x.sessions.handleOf(x.db.sessions.latest('orchestrator')!.id)!;
    expect(x.fake.sent(handle).at(-1)).toMatch(new RegExp(`\\[attached image: ${taskStored.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`));

    const batch = await x.lifecycle.createBatch('r1', 'Rejected proof');
    x.db.batches.update(batch.id, { status: 'review', note: 'ready' });
    const batchRejected = await runAction(`/api/batches/${batch.id}/reject`, { note: 'batch proof', attachments: [{ name: 'batch.png', mime: 'image/png', data: png.toString('base64') }] });
    expect(batchRejected).toMatchObject({ status: 202, result: { action: 'reject', ok: true } });
    const batchRow = x.db.chat.all().filter((row) => row.text === `Batch ${batch.id} rejected: batch proof`).at(-1)!;
    const batchStored = x.db.chat.attachment(batchRow.id, 0)!;
    expect(batchRow.attachments).toEqual([{ name: 'batch.png', mime: 'image/png', size: png.length }]);
    expect(x.db.batches.get(batch.id)?.history).toContain(`Attachment: ${batchStored.path}`);
    expect(x.fake.sent(handle).filter((text) => text.includes(`Batch ${batch.id} rejected`)).at(-1)).toMatch(new RegExp(`\\[attached image: ${batchStored.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`));
    x.db.batches.delete(batch.id);

    await reviewTask('ov-reject-plain');
    expect((await runAction('/api/tasks/ov-reject-plain/reject', { note: 'plain rejection' })).result).toMatchObject({ action: 'reject', ok: true });
    const plainRow = x.db.chat.all().at(-1)!;
    expect(plainRow.attachments).toBeUndefined();
    expect(x.fake.sent(handle).at(-1)).toBe('[Overseer] ov-reject-plain rejected by the user: plain rejection. Re-dispatch it with instructions that address the note.');
  });
  it('finds a never-dispatched bead in the second repository, looking in the repo its id names first, and answers 404 with a message for an unknown one (round 15)', async () => {
    const other = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: other.path, id: 'r2' })).status).toBe(200);
    x.store.add(other.path, { id: 'r2-1', title: 'Only in r2' });
    const show = vi.spyOn(x.store, 'show');
    const d = await json('GET', '/api/tasks/r2-1');
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ bead: { id: 'r2-1' }, repo: { id: 'r2' }, worktree: null });
    expect(show.mock.calls[0]).toEqual([other.path, 'r2-1']); // the repo whose id prefixes the bead id is asked first
    show.mockRestore();
    expect(await json('GET', '/api/tasks/r2-nope')).toEqual({ status: 404, body: { error: 'task r2-nope not found in any repo' } });
    expect((await json('DELETE', '/api/repos/r2')).status).toBe(200);
  });
  // Round 25 R25-4: the pane could only count the beads a blocked one waits on ("waits on 2 other beads"), so the user had to run `bd show` to learn which.
  it('names the beads a blocked one waits on, and reads bd only for a bead that can be waiting', async () => {
    const other = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: other.path, id: 'r3' })).status).toBe(200);
    x.store.add(other.path, { id: 'r3-1', title: 'The blocker' });
    x.store.add(other.path, { id: 'r3-2', title: 'Waits for it' }, ['r3-1']);
    const blockers = vi.spyOn(x.store, 'blocked');
    expect(((await json('GET', '/api/tasks/r3-2')).body as TaskDetail).blocked_by).toEqual(['r3-1']);
    expect(((await json('GET', '/api/tasks/r3-1')).body as TaskDetail).blocked_by).toEqual([]);
    expect(blockers).toHaveBeenCalledTimes(1); // a bead that depends on nothing cannot be blocked: no second bd read
    // A bd hiccup leaves the pane counting them, as it did before, instead of failing the whole detail.
    blockers.mockRejectedValueOnce(new Error('bd blocked failed: locked'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(((await json('GET', '/api/tasks/r3-2')).body as TaskDetail).blocked_by).toEqual([]);
    expect(error.mock.calls[0]?.[0]).toBe('rest: bd blocked failed for a task detail');
    error.mockRestore();
    blockers.mockRestore();
    expect((await json('DELETE', '/api/repos/r3')).status).toBe(200);
  });
  it('browses folders and inspects paths', async () => {
    const roots = await json('GET', '/api/fs/browse');
    expect(roots.body.path).toBeNull();
    const parent = path.dirname(x.t.path);
    const listing = await json('GET', `/api/fs/browse?path=${encodeURIComponent(parent)}`);
    expect(listing.body.entries).toContainEqual({ name: 'repo', path: x.t.path, is_git_repo: true });
    expect((await json('GET', `/api/fs/browse?path=${encodeURIComponent(path.join(parent, 'nope'))}`)).status).toBe(400);
    expect((await json('GET', '/api/fs/browse?path=a&path=b')).status).toBe(400);
    const ins = await json('POST', '/api/repos/inspect', { path: x.t.path });
    expect(ins.body).toMatchObject({ is_git_root: true, branch: 'main', has_beads: true, problems: ['already registered as r1'] });
    expect((await json('POST', '/api/repos/inspect', { path: parent })).body.problems).toEqual(['not the root of a git repository']);
  });
  it('merge and reject through the lifecycle', async () => {
    x.db.repos.update('r1', { review_rounds: 0 }); // the REST merge path, without a review round in between (lifecycle.test covers the round)
    const sid = await x.lifecycle.spawnWorker('r1', 'ov-1', { harness: 'claude' });
    const wt = x.db.worktrees.get('ov-1')!;
    commitFile(wt.path, 'hi.txt', 'hi\n', 'hi');
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n', cost: 0 });
    await until(() => x.db.worktrees.get('ov-1')?.verify_status === 'pass');
    const detail = (await json('GET', '/api/tasks/ov-1')).body as TaskDetail;
    expect(detail.worktree?.verify_status).toBe('pass');
    expect(detail.diff).toContain('+hi');
    expect((await json('POST', '/api/tasks/ov-1/reject', {})).status).toBe(400);
    const m = await runAction('/api/tasks/ov-1/merge');
    expect(m).toMatchObject({ status: 202, result: { action: 'merge', target: 'ov-1', ok: true, data: { mr_url: null } } });
    expect(fs.existsSync(path.join(x.t.path, 'hi.txt'))).toBe(true);
    // The endpoint still accepts the target, so the refusal (not in review) is the job's result, not a 4xx.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const again = await runAction('/api/tasks/ov-1/merge');
    quiet.mockRestore();
    expect(again).toMatchObject({ status: 202, result: { ok: false, message: 'ov-1 is not in review' } });
  });
  it('hands out the push key and keeps subscriptions', async () => {
    const key = (await json('GET', '/api/push/key')).body as { key: string; subscriptions: number };
    expect(key.key.length).toBeGreaterThan(40); expect(key.subscriptions).toBe(0);
    expect((await json('POST', '/api/push/subscriptions', { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } })).status).toBe(204);
    expect((await json('POST', '/api/push/subscriptions', { endpoint: 'nope' })).status).toBe(400);
    expect(((await json('GET', '/api/push/key')).body as { subscriptions: number }).subscriptions).toBe(1);
    // The test notification is the one awaited send: one result per device, the host only.
    expect((await json('POST', '/api/push/test')).body).toEqual({ results: [{ endpoint_host: 'push.example', ok: true }] });
    expect((await json('DELETE', '/api/push/subscriptions', { endpoint: 'https://push.example/1' })).status).toBe(204);
    expect(((await json('GET', '/api/push/key')).body as { subscriptions: number }).subscriptions).toBe(0);
  });
  it('reports the doctor', async () => {
    const r = await json('GET', '/api/doctor');
    expect(r.status).toBe(200);
    expect(r.body.tools).toHaveLength(6);
    expect(r.body.tools[0]).toMatchObject({ name: 'git', required: true, ok: true });
    expect(r.body.tools[0].version).toBe('git 1.0.0');
    expect(r.body.data_dir.ok).toBe(true);
  });
  it('batches, interrupt, sessions, events and costs over REST', async () => {
    x.store.add(x.t.path, { id: 'ov-b1', title: 'Batch bead' });
    const b = await x.lifecycle.createBatch('r1', 'Rest batch');
    expect((await json('GET', `/api/batches/${b.id}`)).body).toMatchObject({ batch: { id: b.id, status: 'open' }, beads: [], diff: '' });
    expect((await json('GET', '/api/batches/nope')).status).toBe(404);
    // A gitlab-mr batch with an MR carries no diff: GitLab shows it and the git diff is the slow part of the route.
    x.db.repos.update('r1', { merge_mode: 'gitlab-mr' }); x.db.batches.update(b.id, { mr_url: 'https://gitlab/mr/1' });
    expect((await json('GET', `/api/batches/${b.id}`)).body).toMatchObject({ diff: null });
    x.db.repos.update('r1', { merge_mode: 'local-merge' }); x.db.batches.update(b.id, { mr_url: null });
    const sid = await x.lifecycle.spawnWorker('r1', 'ov-b1', { harness: 'claude', batchId: b.id });
    const list = vi.spyOn(x.store, 'list');
    const [boardRes, detailRes] = await Promise.all([json('GET', '/api/board'), json('GET', `/api/batches/${b.id}`)]);
    expect(list).toHaveBeenCalledTimes(x.db.repos.all().length); // one coalesced build serves both routes
    list.mockRestore();
    const board = boardRes.body as BoardResponse;
    expect(board.repos[0]!.batches[0]).toMatchObject({ id: b.id, beads_total: 1, beads_done: 0 });
    expect(detailRes.body.beads.map((c: { bead: { id: string } }) => c.bead.id)).toEqual(['ov-b1']);
    expect((await json('GET', `/api/sessions?bead_id=ov-b1`)).body).toHaveLength(1);
    expect((await json('GET', `/api/sessions/${sid}/events`)).body[0]).toMatchObject({ type: 'process_start' });
    expect((await json('GET', '/api/sessions/nope/events')).status).toBe(404);
    expect((await runAction('/api/tasks/ov-b1/interrupt')).result).toMatchObject({ action: 'interrupt', ok: true });
    await until(() => x.db.sessions.get(sid)?.status !== 'running');
    expect((await json('POST', '/api/tasks/ov-b1/interrupt')).status).toBe(400);
    // Retry verification and Re-dispatch are lifecycle calls behind REST; their refusals come back as 400 with the reason.
    expect(await json('POST', '/api/tasks/ov-nope/verify')).toEqual({ status: 400, body: { error: 'no worktree for ov-nope' } });
    expect(await json('POST', '/api/tasks/ov-nope/redispatch')).toEqual({ status: 400, body: { error: 'no worktree for ov-nope' } });
    expect((await json('POST', `/api/batches/${b.id}/reject`, {})).status).toBe(400);
    // Close bead: the stopped bead closes as won't do with the note, its batch stays open and counts it as closed (round 13).
    await until(async () => (await x.store.show(x.t.path, 'ov-b1'))?.status === 'open');
    expect((await runAction('/api/tasks/ov-b1/close', { note: 'not wanted' })).result).toMatchObject({ action: 'close', ok: true });
    expect(await x.store.show(x.t.path, 'ov-b1')).toMatchObject({ status: 'closed', labels: ['overseer:closed'] });
    expect((await json('GET', '/api/board')).body.repos[0].batches[0]).toMatchObject({ id: b.id, status: 'open', beads_total: 1, beads_done: 0, beads_closed: 1 });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closedAgain = await runAction('/api/tasks/ov-b1/close');
    quiet.mockRestore();
    expect(closedAgain).toMatchObject({ status: 202, result: { ok: false, message: 'bead ov-b1 is already closed' } });
    expect((await runAction(`/api/batches/${b.id}/abandon`)).result).toMatchObject({ action: 'abandon', ok: true });
    expect(x.db.batches.get(b.id)?.status).toBe('abandoned');
    const costs = (await json('GET', '/api/costs')).body;
    expect(costs.repos).toEqual([expect.objectContaining({ repo_id: 'r1', unknown: expect.any(Number) })]);
    expect(costs.batches).toEqual([expect.objectContaining({ batch_id: b.id, unknown: expect.any(Number) })]);
  });
  it('serves only the events newer than a seq when `after` is given, and every event without it', async () => {
    x.db.sessions.insert({ id: 'sess-after', harness: 'claude', role: 'worker', bead_id: 'ov-after', repo_id: 'r1', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: x.t.path, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    for (const text of ['one', 'two', 'three']) x.db.events.append('sess-after', 'assistant_text', { text });
    const all = (await json('GET', '/api/sessions/sess-after/events')).body as { seq: number; payload: { text: string } }[];
    expect(all.map((e) => e.payload.text)).toEqual(['one', 'two', 'three']);
    const newer = (await json('GET', `/api/sessions/sess-after/events?after=${all[1]!.seq}`)).body as { payload: { text: string } }[];
    expect(newer.map((e) => e.payload.text)).toEqual(['three']);
    // The last seq has nothing newer, and a seq past every row is empty too: `after` filters, it never means "all".
    expect((await json('GET', `/api/sessions/sess-after/events?after=${all[2]!.seq}`)).body).toEqual([]);
    expect((await json('GET', '/api/sessions/sess-after/events?after=9999')).body).toEqual([]);
    // Zero and a blank value are the whole session (nothing is newer than the first seq); a non-numeric one is refused.
    expect(((await json('GET', '/api/sessions/sess-after/events?after=0')).body as unknown[])).toHaveLength(3);
    expect(((await json('GET', '/api/sessions/sess-after/events?after=')).body as unknown[])).toHaveLength(3);
    expect((await json('GET', '/api/sessions/sess-after/events?after=abc')).status).toBe(400);
    // The parameter does not skip the session check: a missing session still 404s with it.
    expect((await json('GET', '/api/sessions/nope/events?after=1')).status).toBe(404);
  });
});

describe('listenWithRetry', () => {
  it('retries EADDRINUSE before listening successfully', async () => {
    let calls = 0;
    const waits: number[] = [];
    await listenWithRetry(async () => {
      calls += 1;
      if (calls < 3) { const error = new Error('busy') as NodeJS.ErrnoException; error.code = 'EADDRINUSE'; throw error; }
    }, true, async (ms) => { waits.push(ms); });
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 500]);
  });

  it('surfaces EADDRINUSE to the caller when retries are off', async () => {
    let calls = 0;
    const error = new Error('busy') as NodeJS.ErrnoException;
    error.code = 'EADDRINUSE';
    await expect(listenWithRetry(async () => { calls += 1; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('retries EADDRINUSE for a restart successor before listening successfully', async () => {
    let calls = 0;
    const waits: number[] = [];
    await listenWithRetry(async () => {
      calls += 1;
      if (calls < 3) { const error = new Error('busy') as NodeJS.ErrnoException; error.code = 'EADDRINUSE'; throw error; }
    }, true, async (ms) => { waits.push(ms); });
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 500]);
  });

  it('can bound plain-start retries before deciding whether to take over the port', async () => {
    const error = Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
    await expect(listenWithRetry(async () => { throw error; }, true, async () => {}, 2)).rejects.toBe(error);
  });

  it('keeps retrying EADDRINUSE beyond the old fifteen second cutoff', async () => {
    let calls = 0;
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15_001);
    try {
      await listenWithRetry(async () => {
        calls += 1;
        if (calls <= 2) { const error = new Error('busy') as NodeJS.ErrnoException; error.code = 'EADDRINUSE'; throw error; }
      }, true, async () => {});
      expect(calls).toBe(3);
    } finally { now.mockRestore(); }
  });

  it('starts one successor before closing and makes it wait for this process to exit', async () => {
    const order: string[] = [];
    const child = { pid: 9876, once: (event: string, callback: () => void) => { if (event === 'spawn') callback(); }, unref: vi.fn() };
    await relaunchDaemon({ close: async () => { order.push('close'); } } as FastifyInstance, x.config.dataDir, {
      pid: 4321,
      spawn: ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        order.push(`spawn:${options.env?.OVERSEER_RESTART_AFTER_PID}`);
        return child;
      }) as never,
      waitForSuccessor: async () => { order.push('ready'); },
      exit: () => { order.push('exit'); },
    });
    expect(order).toEqual(['spawn:4321', 'ready', 'close', 'exit']);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('exits the parent after a spawned successor even when Fastify shutdown rejects', async () => {
    const exit = vi.fn();
    const closeError = new Error('close failed');
    const child = { pid: 9876, once: (event: string, callback: () => void) => { if (event === 'spawn') callback(); }, unref: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(relaunchDaemon({ close: async () => { throw closeError; } } as unknown as FastifyInstance, x.config.dataDir, {
        spawn: (() => child) as never,
        waitForSuccessor: async () => {},
        exit,
      })).resolves.toBeUndefined();
      expect(exit).toHaveBeenCalledWith(0);
      expect(error.mock.calls[0]?.[0]).toContain('could not close cleanly; exiting so successor 9876 can start');
    } finally { error.mockRestore(); }
  });

  it('bounds a hung Fastify shutdown and exits to release the successor', async () => {
    const exit = vi.fn();
    const child = { pid: 9876, once: (event: string, callback: () => void) => { if (event === 'spawn') callback(); }, unref: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await relaunchDaemon({ close: () => new Promise<void>(() => {}) } as unknown as FastifyInstance, x.config.dataDir, {
        spawn: (() => child) as never,
        waitForSuccessor: async () => {},
        exit,
        closeTimeoutMs: 1,
      });
      expect(exit).toHaveBeenCalledWith(0);
      expect(error.mock.calls[0]?.[0]).toContain('could not close cleanly; exiting so successor 9876 can start');
    } finally { error.mockRestore(); }
  });

  it('keeps the parent online and stops the successor when it does not reach startup', async () => {
    const close = vi.fn();
    const child = { pid: 9876, once: (event: string, callback: () => void) => { if (event === 'spawn') callback(); }, unref: vi.fn() };
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(relaunchDaemon({ close } as unknown as FastifyInstance, x.config.dataDir, {
        spawn: (() => child) as never,
        waitForSuccessor: async () => { throw new Error('did not reach startup'); },
        exit: vi.fn(),
      })).rejects.toThrow('did not reach startup');
      expect(close).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith(9876);
      expect(error.mock.calls[0]?.[0]).toContain('abandoned successor 9876');
    } finally { kill.mockRestore(); error.mockRestore(); }
  });

  it('reads the successor marker from a byte offset after multibyte log output', async () => {
    const file = path.join(x.config.dataDir, 'daemon-restart.log');
    fs.mkdirSync(x.config.dataDir, { recursive: true });
    // 20 four-byte characters: a character offset would land 40 characters into the marker line, past the needle.
    fs.writeFileSync(file, `restart ${'\u{1F680}'.repeat(20)}\n`);
    const offset = fs.statSync(file).size;
    fs.appendFileSync(file, 'overseer daemon restart successor 9876 waiting for parent 4321 to exit\n');
    const child = { pid: 9876, once: () => {} } as never;
    await expect(waitForSuccessorReady(child, file, offset)).resolves.toBeUndefined();
  });
});

describe('waitForRestartParent', () => {
  it('returns false and leaves the successor free to bind when no parent is named', async () => {
    expect(await waitForRestartParent({})).toBe(false);
  });

  it('ignores an invalid parent pid and drops the variable', async () => {
    const env: NodeJS.ProcessEnv = { OVERSEER_RESTART_AFTER_PID: 'not-a-pid' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await waitForRestartParent(env, async () => true, async () => {})).toBe(false);
      expect(env.OVERSEER_RESTART_AFTER_PID).toBeUndefined();
      expect(warn.mock.calls[0]?.[0]).toContain('ignored invalid OVERSEER_RESTART_AFTER_PID=not-a-pid');
    } finally { warn.mockRestore(); }
  });

  it('polls until the parent is gone before returning true', async () => {
    const env: NodeJS.ProcessEnv = { OVERSEER_RESTART_AFTER_PID: '4321', OVERSEER_RESTART_AFTER_STARTED_AT: '2026-01-01T00:00:00.000Z' };
    const waits: number[] = [];
    let calls = 0;
    const alive = async (pid: number): Promise<boolean> => { expect(pid).toBe(4321); calls += 1; return calls < 3; };
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      expect(await waitForRestartParent(env, alive, async (ms) => { waits.push(ms); })).toBe(true);
      // The main check (still the same parent) and the plain-liveness recheck both report "gone" for a truly exited parent.
      expect(calls).toBe(4);
      expect(waits).toEqual([100, 100]);
      expect(env.OVERSEER_RESTART_AFTER_PID).toBeUndefined();
      expect(env.OVERSEER_RESTART_AFTER_STARTED_AT).toBeUndefined();
      expect(info.mock.calls.at(-1)?.[0]).toContain('overseer daemon restart parent 4321 exited; successor');
    } finally { info.mockRestore(); }
  });

  it('stops waiting and logs reuse when the parent pid is alive under a different process', async () => {
    const env: NodeJS.ProcessEnv = { OVERSEER_RESTART_AFTER_PID: '4321', OVERSEER_RESTART_AFTER_STARTED_AT: '2026-01-01T00:00:00.000Z' };
    // Same pid, but its recorded start time no longer matches: Windows reused 4321 for another process.
    const alive = async (pid: number, startedAt: string | null): Promise<boolean> => { expect(pid).toBe(4321); return startedAt === null; };
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      expect(await waitForRestartParent(env, alive, async () => {})).toBe(true);
      expect(info.mock.calls.at(-1)?.[0]).toContain('overseer daemon restart parent pid 4321 was reused by another process; successor');
    } finally { info.mockRestore(); }
  });

  it('gives up after the deadline and logs a timeout instead of waiting forever', async () => {
    const env: NodeJS.ProcessEnv = { OVERSEER_RESTART_AFTER_PID: '4321' };
    const waits: number[] = [];
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      expect(await waitForRestartParent(env, async () => true, async (ms) => { waits.push(ms); now += ms; })).toBe(true);
      expect(waits.length).toBe(600);
      expect(warn.mock.calls.at(-1)?.[0]).toContain('overseer daemon restart gave up waiting for parent 4321 after 60s; successor');
    } finally { clock.mockRestore(); warn.mockRestore(); }
  });

  it('uses a wall-clock deadline when parent identity checks are slow', async () => {
    const env: NodeJS.ProcessEnv = { OVERSEER_RESTART_AFTER_PID: '4321' };
    let now = 0;
    let checks = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      expect(await waitForRestartParent(env, async () => { checks += 1; now += 30_000; return true; }, async () => {})).toBe(true);
      expect(checks).toBe(2);
      expect(warn.mock.calls.at(-1)?.[0]).toContain('after 60s');
    } finally { clock.mockRestore(); warn.mockRestore(); }
  });
});

describe('takeOverPort', () => {
  it('stops only the Overseer daemon holding the port so its workers survive', async () => {
    const stopped: number[] = [];
    expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: null, sourceRoot: null }), stop: async (pid) => { stopped.push(pid); }, holder: async () => null })).toBe(true);
    expect(stopped).toEqual([777]);
  });

  it('refuses to stop an Overseer daemon of another data dir', async () => {
    const stop = vi.fn(async () => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: '/home/u/.overseer', sourceRoot: null }), dataDir: '/tmp/other', stop, holder: async () => null })).toBe(false);
      expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: null, sourceRoot: null }), dataDir: '/tmp/other', stop, holder: async () => null })).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      expect(error.mock.calls[0]?.[0]).toContain('held by the Overseer daemon 777 with data dir /home/u/.overseer, not /tmp/other');
    } finally { error.mockRestore(); }
  });

  it('stops a daemon of the same data dir', async () => {
    const stopped: number[] = [];
    expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: '/tmp/same', sourceRoot: '/overseer/main' }), dataDir: '/tmp/same', sourceRoot: '/overseer/main', stop: async (pid) => { stopped.push(pid); }, holder: async () => null })).toBe(true);
    expect(stopped).toEqual([777]);
  });

  it('refuses to stop a daemon from another checkout that shares its data dir', async () => {
    const stop = vi.fn(async () => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: '/home/u/.overseer', sourceRoot: '/src/overseer-main' }), dataDir: '/home/u/.overseer', sourceRoot: '/src/overseer-worktree', stop, holder: async () => null })).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      expect(error.mock.calls[0]?.[0]).toContain('source root /src/overseer-main, not /src/overseer-worktree; another checkout is not stopped');
    } finally { error.mockRestore(); }
  });

  it('kills nothing and names the process when the port is held by a foreign process', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await takeOverPort(4411, { daemonPid: async () => null, holder: async () => ({ pid: 555, name: 'node.exe' }), stop: async () => { throw new Error('must not stop'); } })).toBe(false);
      expect(error.mock.calls[0]?.[0]).toContain('port 4411 is held by pid 555 (node.exe), which is not an Overseer daemon; nothing was stopped');
    } finally { error.mockRestore(); }
  });

  it('retries a bind race when no port holder can be found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await takeOverPort(4411, { daemonPid: async () => null, holder: async () => null })).toBeNull();
      expect(warn.mock.calls[0]?.[0]).toContain('could not identify the holder of port 4411; retrying the bind before takeover');
    } finally { warn.mockRestore(); }
  });

  it('a watch start names the daemon holding the port and never stops it', async () => {
    const stop = vi.fn(async () => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: null, sourceRoot: null }), holder: async () => ({ pid: 777, name: 'node.exe' }), stop, takeOver: false })).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      expect(error.mock.calls[0]?.[0]).toContain('port 4411 is held by pid 777 (node.exe); watcher mode will not stop it');
    } finally { error.mockRestore(); }
  });

  it('names an Overseer daemon that still holds its port after a failed stop', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await takeOverPort(4411, { daemonPid: async () => ({ pid: 777, dataDir: null, sourceRoot: null }), stop: async () => {}, holder: async () => ({ pid: 777, name: 'node' }), wait: async () => {} })).toBe(false);
      expect(error.mock.calls[0]?.[0]).toContain('Overseer daemon 777 still holds it after 10 seconds of shutdown');
    } finally { error.mockRestore(); }
  });
});

describe('repo registration, patch and delete', () => {
  it('initialises beads in stealth mode by default and commit mode on request', async () => {
    const a = copyTmpRepo(template);
    const r = await json('POST', '/api/repos', { path: a.path, id: 'stealth-a' });
    expect(r.status).toBe(200);
    expect(x.store.inits.at(-1)).toEqual({ repoPath: a.path, prefix: 'stealth-a', mode: 'stealth' });
    expect(fs.existsSync(path.join(a.path, '.beads'))).toBe(true);
    const b = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: b.path, id: 'commit-b', beads: 'commit' })).status).toBe(200);
    expect(x.store.inits.at(-1)).toMatchObject({ prefix: 'commit-b', mode: 'commit' });
    const before = x.store.inits.length;
    const c = copyTmpRepo(template);
    fs.mkdirSync(path.join(c.path, '.beads'));
    expect((await json('POST', '/api/repos', { path: c.path, id: 'has-beads-c' })).status).toBe(200);
    expect(x.store.inits.length).toBe(before);
  });
  it('rejects bad ids, non-roots and failed inits without inserting', async () => {
    const t = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: t.path, id: 'Bad_Id' })).status).toBe(400);
    const sub = path.join(t.path, 'sub');
    fs.mkdirSync(sub);
    const nr = await json('POST', '/api/repos', { path: sub, id: 'sub' });
    expect(nr.status).toBe(400);
    expect(nr.body.error).toBe('not the root of a git repository');
    x.store.failInit = 'dolt exploded';
    const count = (await json('GET', '/api/repos')).body.length;
    const f = await json('POST', '/api/repos', { path: t.path, id: 'fail-t' });
    x.store.failInit = null;
    expect(f.status).toBe(400);
    expect(f.body.error).toContain('dolt exploded');
    expect((await json('GET', '/api/repos')).body.length).toBe(count);
    expect(fs.existsSync(path.join(t.path, '.beads'))).toBe(false);
  });
  it('patches fields and rejects empty or unknown patches', async () => {
    const t = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: t.path, id: 'patch-t' })).status).toBe(200);
    const seen: string[] = [];
    const off = x.bus.on('repos', () => seen.push('repos'));
    const r = await json('PATCH', '/api/repos/patch-t', { worker_limit: 3, verify_command: 'pnpm test', review_command: 'pnpm test:review' });
    off();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'patch-t', worker_limit: 3, verify_command: 'pnpm test', review_command: 'pnpm test:review', merge_mode: 'local-merge' });
    expect(seen).toEqual(['repos']);
    expect((await json('PATCH', '/api/repos/patch-t', { review_rounds: 4 })).status).toBe(200);
    expect((await json('GET', '/api/repos')).body).toContainEqual(expect.objectContaining({ id: 'patch-t', review_rounds: 4 }));
    // A verify command changed in Setup reaches the orchestrator: its preamble carries the old one and it narrated that one while
    // the daemon ran the new one (round 19 R19-2). Only a real change says anything.
    const chat = () => x.db.chat.all();
    const before = chat().length;
    expect((await json('PATCH', '/api/repos/patch-t', { verify_command: 'node -e "process.exit(1)"' })).status).toBe(200);
    // The bead of a worker running now is verified with the new command (the repo row is read when the worker ends), so the notice
    // says so instead of leaving "running workers keep their settings" to be relayed as the opposite (fix round 19 review NB-3).
    expect(chat().at(-1)).toMatchObject({ role: 'system', text: 'Repository patch-t now has verify command `node -e "process.exit(1)"` (was verify command `pnpm test`), changed by the user in Setup. Running workers keep the prompt and settings they started with; the next verification uses the new command, including the one that runs when a worker running now ends.' });
    expect((await json('PATCH', '/api/repos/patch-t', { worker_limit: 4 })).status).toBe(200);
    expect((await json('PATCH', '/api/repos/patch-t', { verify_command: 'node -e "process.exit(1)"' })).status).toBe(200);
    expect(chat().length).toBe(before + 1);
    // Clearing it says so too, in the same words as every other verification notice.
    expect((await json('PATCH', '/api/repos/patch-t', { verify_command: null })).status).toBe(200);
    expect(chat().at(-1)!.text).toBe('Repository patch-t now has no verify command configured (was verify command `node -e "process.exit(1)"`), changed by the user in Setup. Running workers keep the prompt and settings they started with; nothing is verified from now on, including when a worker running now ends.');
    // An empty command is stored as null, so this one changes nothing and says nothing; it read "now has no verify command
    // configured (was no verify command configured)" (fix round 19 review NB-7).
    const cleared = chat().length;
    expect((await json('PATCH', '/api/repos/patch-t', { verify_command: '' })).status).toBe(200);
    expect(x.db.repos.get('patch-t')!.verify_command).toBeNull();
    expect(chat().length).toBe(cleared);
    // The setup command is a repo field of its own, stored and announced the same way, and an empty one is null too (overseer-ldh).
    expect((await json('PATCH', '/api/repos/patch-t', { setup_command: 'pnpm install' })).body).toMatchObject({ setup_command: 'pnpm install' });
    expect(chat().at(-1)!.text).toMatch(/^Repository patch-t now has setup command `pnpm install` \(was no setup command configured\), changed by the user in Setup\./);
    expect((await json('PATCH', '/api/repos/patch-t', { setup_command: '' })).status).toBe(200);
    expect(x.db.repos.get('patch-t')!.setup_command).toBeNull();
    expect(chat().length).toBe(cleared + 2);
    expect((await json('PATCH', '/api/repos/patch-t', { review_command: '  pnpm test:review:next  ' })).body).toMatchObject({ review_command: 'pnpm test:review:next' });
    expect(chat().at(-1)!.text).toBe('Repository patch-t now has review command `pnpm test:review:next` (was review command `pnpm test:review`), changed by the user in Setup. The daemon uses it before the next batch review request.');
    expect((await json('PATCH', '/api/repos/patch-t', { review_command: '   ' })).body).toMatchObject({ review_command: null });
    expect(chat().at(-1)!.text).toBe('Repository patch-t now has no review command configured (was review command `pnpm test:review:next`), changed by the user in Setup. The daemon uses it before the next batch review request.');
    expect(x.db.repos.get('patch-t')!.review_command).toBeNull();
    expect((await json('PATCH', '/api/repos/patch-t', {})).status).toBe(400);
    expect((await json('PATCH', '/api/repos/patch-t', { id: 'nope' })).status).toBe(400);
    expect((await json('PATCH', '/api/repos/missing', { worker_limit: 1 })).status).toBe(404);
  });
  it('probes on save and serves the preflight history', async () => {
    const t = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: t.path, id: 'pf-t' })).status).toBe(200);
    expect((await json('PATCH', '/api/repos/pf-t', { verify_command: 'node -e "process.exit(1)"' })).status).toBe(200);
    await until(() => x.db.preflight.latest('pf-t')?.result === 'fail', 10_000, 'probe');
    const res = await json('GET', '/api/repos/pf-t/preflight');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runs: [{ result: 'fail', exit_code: 1 }], crashes: [] });
    expect((await json('POST', '/api/repos/pf-t/probe')).status).toBe(202);
    expect((await json('POST', '/api/repos/nope/probe')).status).toBe(404);
  });
  it('does not probe when a save leaves both commands alone', async () => {
    const t = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: t.path, id: 'pf-noop' })).status).toBe(200);
    expect((await json('PATCH', '/api/repos/pf-noop', { worker_limit: 3 })).status).toBe(200);
    expect(x.db.preflight.latest('pf-noop')).toBeUndefined();
  });
  it('task detail for a merged bead whose worktree folder is stale and whose branches are gone returns no diff instead of throwing', async () => {
    const t = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: t.path, id: 'st' })).status).toBe(200);
    const repo = x.db.repos.get('st')!;
    x.store.add(t.path, { id: 'st-1', title: 'merged', description: '' });
    const wt = await ensureWorktree(repo, 'st-1', x.config.worktreesDir, 'main');
    sh(t.path, ['branch', 'feature/st-b1', 'main']);
    x.db.worktrees.upsert({ bead_id: 'st-1', repo_id: 'st', path: wt.path, branch: wt.branch, base_branch: 'feature/st-b1', verify_status: 'pass', verify_output: null, review_note: null, conflict_files: null, merged_at: new Date().toISOString(), mr_url: null, batch_id: null, closed_at: null , review_round: null, review_findings: null, accepted_note: null });
    // The batch merged: git forgot the worktree and both branches are deleted, but the folder itself survived (Windows keeps a lock
    // on it now and then), so an existence check on the folder alone still runs git in a directory that is no longer a repository.
    sh(t.path, ['worktree', 'remove', '--force', wt.path]);
    sh(t.path, ['branch', '-D', wt.branch, 'feature/st-b1']);
    fs.mkdirSync(wt.path, { recursive: true });
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      const r = await json('GET', '/api/tasks/st-1');
      expect(r.status).toBe(200);
      expect((r.body as TaskDetail).diff).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });
  it('orchestrator and tier settings round-trip over REST, refusing a denied model or an unknown tier', async () => {
    const got = await json('GET', '/api/settings/orchestrator');
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ model: null, effort: null, promptOverride: null, usageThresholdPercent: x.config.usageThresholdPercent });
    const put = await json('PUT', '/api/settings/orchestrator', { model: 'sonnet', effort: 'high', promptOverride: 'be terse' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ model: 'sonnet', effort: 'high', promptOverride: 'be terse', applies_to: 'next-session' });
    expect((await json('GET', '/api/settings/orchestrator')).body).toEqual({ model: 'sonnet', effort: 'high', promptOverride: 'be terse', usageThresholdPercent: x.config.usageThresholdPercent });

    const tiers = (await json('GET', '/api/settings/tiers')).body;
    expect(tiers.tiers.length).toBeGreaterThan(0);
    expect(tiers.denyModels).toContain('gpt-6-astra');
    const astra = {
      tiers: [
        { name: 'chore', candidates: [{ harness: 'codex', model: 'gpt-6-astra', effort: null }] },
        { name: 'standard', candidates: [{ harness: 'claude', model: 'sonnet', effort: null }] },
        { name: 'hard', candidates: [{ harness: 'claude', model: 'opus', effort: null }] },
        { name: 'critic', candidates: [{ harness: 'claude', model: 'fable', effort: null }] },
      ],
      denyModels: ['gpt-6-astra'],
    };
    const rejected = await json('PUT', '/api/settings/tiers', astra);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain('gpt-6-astra');
    const badName = { tiers: [{ name: 'nonsense', candidates: [] }], denyModels: [] };
    expect((await json('PUT', '/api/settings/tiers', badName)).status).toBe(400);
    const oneCandidate = (model: string, harness: HarnessName = 'claude', effort: 'ultra' | null = null) => [{ harness, model, effort }];
    const ultraSettings = (harness: HarnessName, model: string) => ({
      tiers: [
        { name: 'chore', candidates: oneCandidate(model, harness, 'ultra') },
        { name: 'standard', candidates: oneCandidate('sonnet') },
        { name: 'hard', candidates: oneCandidate('opus') },
        { name: 'critic', candidates: oneCandidate('fable') },
      ],
      denyModels: [],
    });
    const custom = {
      tiers: [
        { name: 'chore', candidates: oneCandidate('haiku') },
        { name: 'standard', candidates: oneCandidate('sonnet') },
        { name: 'hard', candidates: oneCandidate('opus') },
        { name: 'critic', candidates: oneCandidate('fable') },
      ],
      denyModels: [],
    };
    // A body missing a tier, or missing candidates on one, is refused before it is persisted rather than stored and only
    // failing later at dispatch time with a TierError (review round: PUT accepted an incomplete tier map silently).
    const missing = { tiers: custom.tiers.slice(0, 3), denyModels: [] };
    const missingResult = await json('PUT', '/api/settings/tiers', missing);
    expect(missingResult.status).toBe(400);
    expect(missingResult.body.error).toContain('critic');
    const emptyCandidates = { tiers: [...custom.tiers.slice(0, 3), { name: 'critic', candidates: [] }], denyModels: [] };
    const emptyResult = await json('PUT', '/api/settings/tiers', emptyCandidates);
    expect(emptyResult.status).toBe(400);
    expect(emptyResult.body.error).toContain('critic');
    expect((await json('GET', '/api/settings/tiers')).body).toEqual(tiers); // neither incomplete PUT persisted

    const codexUltra = ultraSettings('codex', 'gpt-6.1-sol');
    const acceptedUltra = await json('PUT', '/api/settings/tiers', codexUltra);
    expect(acceptedUltra.status).toBe(200);
    expect(acceptedUltra.body).toEqual({ ...codexUltra, applies_to: 'next-session' });
    expect((await json('GET', '/api/settings/tiers')).body).toEqual(codexUltra);
    const customCodexUltra = ultraSettings('codex', 'custom-codex-model');
    expect((await json('PUT', '/api/settings/tiers', customCodexUltra)).status).toBe(200);
    expect((await json('GET', '/api/settings/tiers')).body).toEqual(customCodexUltra);
    for (const [harness, model] of [
      ['claude', 'sonnet'],
      ['opencode', 'deepseek/deepseek-flash'],
      ['codex', 'gpt-6-luna'],
    ] as const) {
      const refusedUltra = await json('PUT', '/api/settings/tiers', ultraSettings(harness, model));
      expect(refusedUltra.status).toBe(400);
      expect(refusedUltra.body.error).toContain(`${harness} candidate "${model}"`);
      expect((await json('GET', '/api/settings/tiers')).body).toEqual(customCodexUltra);
    }
    const refusedOrchestratorUltra = await json('PUT', '/api/settings/orchestrator', { model: 'sonnet', effort: 'ultra', promptOverride: 'be terse' });
    expect(refusedOrchestratorUltra.status).toBe(400);
    expect((await json('GET', '/api/settings/orchestrator')).body).toMatchObject({ model: 'sonnet', effort: 'high' });

    const putTiers = await json('PUT', '/api/settings/tiers', custom);
    expect(putTiers.status).toBe(200);
    expect(putTiers.body).toEqual({ ...custom, applies_to: 'next-session' });
    expect((await json('GET', '/api/settings/tiers')).body).toEqual(custom);
  });
  it('manages accounts, validates settings references, and verifies with the account environment', async () => {
    const originalTiers = x.db.settings.tiers();
    const originalOrchestrator = x.db.settings.orchestrator();
    fs.mkdirSync(x.config.dataDir, { recursive: true });
    expect((await json('POST', '/api/accounts', { name: 'Missing', harness: 'claude', kind: 'api_key' })).status).toBe(400);
    expect((await json('POST', '/api/accounts', { name: 'Missing provider', harness: 'opencode', kind: 'api_key', secret: 'deepseek-key' })).status).toBe(400);
    expect((await json('POST', '/api/accounts', { name: 'Unknown provider', harness: 'opencode', kind: 'api_key', provider: 'unknown', secret: 'key' })).status).toBe(400);
    const deepseek = await json('POST', '/api/accounts', { name: 'DeepSeek', harness: 'opencode', kind: 'api_key', provider: 'deepseek', secret: 'deepseek-key' });
    expect(deepseek.body).toMatchObject({ harness: 'opencode', kind: 'api_key', provider: 'deepseek', has_secret: true, logged_in: true });
    expect(x.db.accounts.get(deepseek.body.id)).toMatchObject({ provider: 'deepseek', secret: 'deepseek-key' });
    expect(JSON.stringify(deepseek.body) + JSON.stringify((await json('GET', '/api/accounts')).body)).not.toContain('deepseek-key');
    const editedDeepseek = await json('PATCH', `/api/accounts/${deepseek.body.id}`, { provider: 'deepseek', secret: 'replacement-deepseek-key' });
    expect(editedDeepseek.body).toMatchObject({ provider: 'deepseek', has_secret: true, logged_in: true });
    expect(JSON.stringify(editedDeepseek.body)).not.toContain('replacement-deepseek-key');
    expect((await json('PATCH', `/api/accounts/${deepseek.body.id}`, { provider: '' })).status).toBe(400);
    expect((await json('PATCH', `/api/accounts/${deepseek.body.id}`, { provider: 'unknown' })).status).toBe(400);
    const created = await json('POST', '/api/accounts', { name: 'Work', label: ' Work ', harness: 'claude', kind: 'oauth_token', secret: 'token-1' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: 'Work', label: 'Work', harness: 'claude', kind: 'oauth_token', has_secret: true, logged_in: true });
    expect(typeof created.body.has_secret).toBe('boolean');
    expect(created.body).not.toHaveProperty('secret');
    const accountId = created.body.id as string;
    expect((await json('GET', '/api/accounts')).body).toContainEqual(created.body);
    const patched = await json('PATCH', `/api/accounts/${accountId}`, { name: 'Personal', label: 'personal', secret: 'token-2' });
    expect(patched.body).toMatchObject({ id: accountId, name: 'Personal', label: 'personal', has_secret: true });
    expect(patched.body).not.toHaveProperty('secret');
    expect((await json('PATCH', `/api/accounts/${accountId}`, { label: '' })).body).toMatchObject({ label: null });
    expect((await json('PATCH', `/api/accounts/${accountId}`, { label: 'x'.repeat(41) })).status).toBe(400);

    const tiers = {
      tiers: ['chore', 'standard', 'hard', 'critic'].map((name) => ({ name, candidates: [{ harness: 'claude', model: name === 'critic' ? 'fable' : 'sonnet', effort: null, account: accountId }] })),
      denyModels: [],
    };
    expect((await json('PUT', '/api/settings/tiers', tiers)).status).toBe(200);
    const unknownTiers = structuredClone(tiers);
    unknownTiers.tiers[0]!.candidates[0]!.account = 'missing';
    expect(await json('PUT', '/api/settings/tiers', unknownTiers)).toMatchObject({ status: 400, body: { error: 'unknown account missing' } });
    x.db.accounts.insert({ id: 'codex-a', name: 'Codex', harness: 'codex', kind: 'codex_home', home: 'C:/accounts/codex-a', created_at: 't0', last_login_at: null, last_verified_at: null });
    const mismatchTiers = structuredClone(tiers);
    mismatchTiers.tiers[0]!.candidates[0]!.account = 'codex-a';
    expect((await json('PUT', '/api/settings/tiers', mismatchTiers)).body.error).toBe('account codex-a does not match claude');
    expect((await json('DELETE', `/api/accounts/${accountId}`)).status).toBe(409);

    x.db.settings.set('tiers', originalTiers);
    expect((await json('PUT', '/api/settings/orchestrator', { model: null, effort: null, promptOverride: null, account: accountId })).status).toBe(200);
    expect(await json('PUT', '/api/settings/orchestrator', { model: null, effort: null, promptOverride: null, account: 'missing' })).toMatchObject({ status: 400, body: { error: 'unknown account missing' } });
    expect((await json('DELETE', `/api/accounts/${accountId}`)).status).toBe(409);

    const loggedOut = await json('POST', '/api/accounts', { name: 'Logged out Claude', label: 'Work', harness: 'claude', kind: 'oauth_token' });
    expect(loggedOut.body).toMatchObject({ has_secret: false, logged_in: false });
    const loggedOutTiers = structuredClone(tiers);
    loggedOutTiers.tiers[0]!.candidates[0]!.account = loggedOut.body.id;
    expect(await json('PUT', '/api/settings/tiers', loggedOutTiers)).toMatchObject({ status: 400, body: { error: 'account Logged out Claude (Work) is not logged in' } });
    expect(await json('PUT', '/api/settings/orchestrator', { model: null, effort: null, promptOverride: null, account: loggedOut.body.id })).toMatchObject({ status: 400, body: { error: 'account Logged out Claude (Work) is not logged in' } });
    // Verifying would otherwise spawn on the machine login, exit 0 and mark the account verified.
    expect(await json('POST', `/api/accounts/${loggedOut.body.id}/verify`)).toMatchObject({ status: 400, body: { error: 'account Logged out Claude (Work) is not logged in' } });
    expect(x.db.accounts.get(loggedOut.body.id)?.last_verified_at).toBeNull();
    expect((await json('DELETE', `/api/accounts/${loggedOut.body.id}`)).status).toBe(200);

    const fakeProcess: LineProcess = {
      child: { kill: vi.fn(), stderrText: '' } as unknown as LineProcess['child'],
      pid: 4242,
      stdin: null,
      lines: (async function* () { yield '{"result":"ok"}'; })(),
      exit: Promise.resolve(0),
      logOffset: () => 0,
    };
    const spawn = vi.spyOn(procs, 'spawnLines').mockReturnValue(fakeProcess);
    try {
      expect(await json('POST', `/api/accounts/${accountId}/verify`)).toEqual({ status: 200, body: { ok: true } });
      expect(spawn.mock.calls[0]![2]?.env).toStrictEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'token-2', ANTHROPIC_API_KEY: undefined });
      expect(spawn.mock.calls[0]![1]).toContain('--max-turns');
      expect(x.db.accounts.get(accountId)?.last_verified_at).toEqual(expect.any(String));
      expect(await json('POST', `/api/accounts/${deepseek.body.id}/verify`)).toEqual({ status: 200, body: { ok: true } });
      expect(spawn.mock.calls[1]![0]).toBe(x.config.opencodeBin);
      expect(spawn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['run']));
      expect(spawn.mock.calls[1]![1]).not.toContain('reply with ok');
      expect(spawn.mock.calls[1]![2]?.env).toStrictEqual({ DEEPSEEK_API_KEY: 'replacement-deepseek-key', OPENCODE_PERMISSION });
    } finally {
      spawn.mockRestore();
      x.db.settings.set('tiers', originalTiers);
      x.db.settings.set('orchestrator', originalOrchestrator);
      x.db.accounts.remove('codex-a');
    }
    expect((await json('DELETE', `/api/accounts/${accountId}`)).status).toBe(200);
    expect((await json('DELETE', `/api/accounts/${deepseek.body.id}`)).status).toBe(200);
    expect((await json('GET', '/api/accounts')).body).toEqual([]);
  });
  it('treats a codex home holding auth.json as logged in without a login stamp', async () => {
    const originalTiers = x.db.settings.tiers();
    fs.mkdirSync(x.config.dataDir, { recursive: true });
    const codex = await json('POST', '/api/accounts', { name: 'Hand Codex', harness: 'codex', kind: 'codex_home' });
    const home = x.db.accounts.get(codex.body.id)!.home!;
    const codexTiers = () => ({
      tiers: ['chore', 'standard', 'hard', 'critic'].map((name) => ({ name, candidates: [{ harness: 'codex', model: 'gpt-5.6-luna', effort: null, account: codex.body.id }] })),
      denyModels: [],
    });
    try {
      expect(x.db.accounts.get(codex.body.id)?.last_login_at).toBeNull();
      expect(codex.body).toMatchObject({ has_secret: false, logged_in: false });
      expect(await json('PUT', '/api/settings/tiers', codexTiers())).toMatchObject({ status: 400, body: { error: 'account Hand Codex is not logged in' } });
      // `codex login` run by hand against this CODEX_HOME writes auth.json and nothing else; only this daemon's login route
      // stamps last_login_at, so such an account must not read as logged out.
      fs.writeFileSync(path.join(home, 'auth.json'), '{}');
      expect((await json('GET', '/api/accounts')).body).toContainEqual(expect.objectContaining({ id: codex.body.id, has_secret: false, logged_in: true }));
      expect((await json('PUT', '/api/settings/tiers', codexTiers())).status).toBe(200);
    } finally {
      x.db.settings.set('tiers', originalTiers);
      await json('DELETE', `/api/accounts/${codex.body.id}`);
    }
  });
  it('verify clears an authentication hold on the account', async () => {
    const created = await json('POST', '/api/accounts', { name: 'Parked Claude', harness: 'claude', kind: 'oauth_token', secret: 'parked-token' });
    const id = created.body.id;
    x.db.accounts.update(id, { exhausted_until: AUTH_HOLD_UNTIL });
    const fakeProcess: LineProcess = {
      child: { kill: vi.fn(), stderrText: '' } as unknown as LineProcess['child'],
      pid: 4242,
      stdin: null,
      lines: (async function* () { yield '{"result":"ok"}'; })(),
      exit: Promise.resolve(0),
      logOffset: () => 0,
    };
    const spawn = vi.spyOn(procs, 'spawnLines').mockReturnValue(fakeProcess);
    try {
      expect(await json('POST', `/api/accounts/${id}/verify`)).toEqual({ status: 200, body: { ok: true } });
      expect(x.db.accounts.get(id)?.exhausted_until).toBeNull();
    } finally {
      spawn.mockRestore();
      await json('DELETE', `/api/accounts/${id}`);
    }
  });
  it('refreshes expiring Claude OAuth before worker start and refuses a failed refresh', async () => {
    const originalTiers = x.db.settings.tiers();
    const oldTokenUrl = x.config.anthropicTokenUrl;
    const requests: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>; requests.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (body.refresh_token === 'bad-refresh') { res.statusCode = 401; res.end('{"error":"invalid_grant"}'); return; }
        res.end(JSON.stringify({ access_token: 'fresh-access-secret', refresh_token: 'rotated-refresh-secret', expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    x.config.anthropicTokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    const failedExpiry = Date.now() - 1;
    x.db.accounts.insert({ id: 'refresh-ok', name: 'Refresh OK', harness: 'claude', kind: 'oauth_token', secret: 'old-access-secret', refresh_token: 'good-refresh', token_expires_at: Date.now() - 1, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    x.db.accounts.insert({ id: 'refresh-bad', name: 'Refresh bad', harness: 'claude', kind: 'oauth_token', secret: 'old-bad-secret', refresh_token: 'bad-refresh', token_expires_at: failedExpiry, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(originalTiers);
    const standard = tiers.tiers.find((tier) => tier.name === 'standard')!;
    try {
      standard.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'refresh-ok' }]; x.db.settings.set('tiers', tiers);
      x.store.add(x.t.path, { id: 'oauth-refresh-ok', title: 'Refresh OAuth' });
      const sid = await x.lifecycle.spawnWorker('r1', 'oauth-refresh-ok', { tier: 'standard' });
      const handle = x.sessions.handleOf(sid)!;
      expect(x.fake.sessions.get(handle.id)!.opts.env).toStrictEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'fresh-access-secret', ANTHROPIC_API_KEY: undefined });
      expect(x.db.accounts.get('refresh-ok')).toMatchObject({ secret: 'fresh-access-secret', refresh_token: 'rotated-refresh-secret', token_expires_at: expect.any(Number) });
      await x.sessions.end(sid); await until(() => x.db.sessions.get(sid)?.status !== 'running');

      standard.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: 'refresh-bad' }]; x.db.settings.set('tiers', tiers);
      x.store.add(x.t.path, { id: 'oauth-refresh-bad', title: 'Reject OAuth refresh' });
      await expect(x.lifecycle.spawnWorker('r1', 'oauth-refresh-bad', { tier: 'standard' })).rejects.toThrow('account Refresh bad is not logged in');
      expect(x.db.accounts.get('refresh-bad')).toMatchObject({ secret: 'old-bad-secret', refresh_token: 'bad-refresh', token_expires_at: failedExpiry });
      expect((await x.store.show(x.t.path, 'oauth-refresh-bad'))?.notes).toContain('Anthropic OAuth refresh failed (HTTP 401)');
      expect(x.db.worktrees.get('oauth-refresh-bad')).toBeUndefined();
      expect(requests).toEqual([
        { grant_type: 'refresh_token', refresh_token: 'good-refresh', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' },
        { grant_type: 'refresh_token', refresh_token: 'bad-refresh', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' },
      ]);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl; x.db.settings.set('tiers', originalTiers);
      x.db.accounts.remove('refresh-ok'); x.db.accounts.remove('refresh-bad');
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
  it('times out a stalled token endpoint and leaves credentials unchanged', async () => {
    const originalTiers = x.db.settings.tiers();
    const oldTokenUrl = x.config.anthropicTokenUrl;
    const stalledServer = createServer((req, res) => {
      // Accept the connection but never respond, so the request times out.
    });
    await new Promise<void>((resolve) => stalledServer.listen(0, '127.0.0.1', resolve));
    x.config.anthropicTokenUrl = `http://127.0.0.1:${(stalledServer.address() as AddressInfo).port}/token`;
    x.config.anthropicTokenTimeoutMs = 25;
    const accountId = 'timeout-account';
    const originalSecret = 'original-access-secret';
    const originalRefresh = 'original-refresh-token';
    x.db.accounts.insert({ id: accountId, name: 'Timeout Account', harness: 'claude', kind: 'oauth_token', secret: originalSecret, refresh_token: originalRefresh, token_expires_at: Date.now() - 1, home: null, created_at: 't0', last_login_at: 't0', last_verified_at: null });
    const tiers = structuredClone(originalTiers);
    const standard = tiers.tiers.find((tier) => tier.name === 'standard')!;
    try {
      standard.candidates = [{ harness: 'claude', model: 'sonnet', effort: null, account: accountId }]; x.db.settings.set('tiers', tiers);
      x.store.add(x.t.path, { id: 'oauth-timeout', title: 'Timeout OAuth' });
      await expect(x.lifecycle.spawnWorker('r1', 'oauth-timeout', { tier: 'standard' })).rejects.toThrow('account Timeout Account is not logged in');
      // Credentials are unchanged after the timeout.
      expect(x.db.accounts.get(accountId)).toMatchObject({ secret: originalSecret, refresh_token: originalRefresh, token_expires_at: expect.any(Number) });
      expect((await x.store.show(x.t.path, 'oauth-timeout'))?.notes).toMatch(/timeout/);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl; x.config.anthropicTokenTimeoutMs = 10_000; x.db.settings.set('tiers', originalTiers);
      x.db.accounts.remove(accountId);
      await new Promise<void>((resolve, reject) => stalledServer.close((err) => err ? reject(err) : resolve()));
    }
  });
  it('runs account login state machines without exposing secrets', async () => {
    fs.mkdirSync(x.config.dataDir, { recursive: true });
    const oldCodex = x.config.codexBin;
    x.config.codexBin = stubBin('codex-login-stub', `
      const fs = require('node:fs'); const path = require('node:path');
      if (process.argv[2] === 'login' && process.argv[3] === 'status') {
        if (!fs.existsSync(path.join(process.env.CODEX_HOME, 'slow-status'))) process.exit(0);
        fs.writeFileSync(path.join(process.env.CODEX_HOME, 'status.pid'), String(process.pid));
        setInterval(() => {}, 1000);
        return;
      }
      console.log('Welcome to Codex [v\\x1b[90m0.154.0\\x1b[0m]');
      console.log('Learn more at https://developers.openai.com/codex');
      console.log('1. Open this link in your browser and sign in to your account');
      console.log('\\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m');
      console.log('2. Enter this one-time code (expires in 15 minutes)');
      console.log('');
      console.log('   \\x1b[94mELSI-U28W\\x1b[0m');
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'login.pid'), String(process.pid));
      if (fs.existsSync(path.join(process.env.CODEX_HOME, 'fail'))) {
        console.error('first failure line'); console.error('device authorization expired'); process.exit(2);
      }
      if (fs.existsSync(path.join(process.env.CODEX_HOME, 'complete'))) setTimeout(() => process.exit(0), 30);
      else setInterval(() => {}, 1000);
    `);
    const codex = await json('POST', '/api/accounts', { name: 'Codex login', harness: 'codex', kind: 'codex_home' });
    fs.writeFileSync(path.join(x.db.accounts.get(codex.body.id)!.home!, 'complete'), 'yes');
    const pendingCodex = await json('POST', '/api/accounts', { name: 'Pending Codex', harness: 'codex', kind: 'codex_home' });
    const failedCodex = await json('POST', '/api/accounts', { name: 'Failed Codex', harness: 'codex', kind: 'codex_home' });
    fs.writeFileSync(path.join(x.db.accounts.get(failedCodex.body.id)!.home!, 'fail'), 'yes');
    const claude = await json('POST', '/api/accounts', { name: 'Claude login', harness: 'claude', kind: 'oauth_token' });
    const fallbackClaude = await json('POST', '/api/accounts', { name: 'Claude fallback', harness: 'claude', kind: 'oauth_token' });
    const tokenRequests: Record<string, unknown>[] = [];
    const tokenServer = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        tokenRequests.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (body.code === 'reject-code') { res.statusCode = 400; res.end('{"error":"invalid_grant"}'); return; }
        res.end(JSON.stringify({ access_token: 'oauth-access-secret', refresh_token: 'oauth-refresh-secret', expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    const oldTokenUrl = x.config.anthropicTokenUrl;
    x.config.anthropicTokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`;
    try {
      expect((await json('POST', `/api/accounts/${codex.body.id}/login`)).body).toMatchObject({ state: 'pending', instructions: 'Open the URL and enter the code.' });
      await until(() => x.db.accounts.get(codex.body.id)?.last_login_at !== null);
      expect((await json('GET', `/api/accounts/${codex.body.id}/login`)).body).toMatchObject({ state: 'done', url: 'https://auth.openai.com/codex/device', code: 'ELSI-U28W' });

      expect((await json('POST', `/api/accounts/${pendingCodex.body.id}/login`)).body.state).toBe('pending');
      await until(async () => (await json('GET', `/api/accounts/${pendingCodex.body.id}/login`)).body.code === 'ELSI-U28W');
      expect((await json('POST', `/api/accounts/${pendingCodex.body.id}/login`)).status).toBe(409);
      const pendingPid = Number(fs.readFileSync(path.join(x.db.accounts.get(pendingCodex.body.id)!.home!, 'login.pid'), 'utf8'));
      expect((await json('DELETE', `/api/accounts/${pendingCodex.body.id}/login`)).body).toEqual({ state: 'idle' });
      expect((await json('GET', `/api/accounts/${pendingCodex.body.id}/login`)).body).toEqual({ state: 'idle' });
      await until(() => !procs.pidExists(pendingPid));

      expect((await json('POST', `/api/accounts/${failedCodex.body.id}/login`)).body.state).toBe('pending');
      await until(async () => (await json('GET', `/api/accounts/${failedCodex.body.id}/login`)).body.state === 'failed');
      expect((await json('GET', `/api/accounts/${failedCodex.body.id}/login`)).body.error).toBe('device authorization expired');
      expect(fs.readFileSync(path.join(x.config.dataDir, 'accounts', failedCodex.body.id, 'login.log'), 'utf8')).toContain('device authorization expired');

      const pendingClaude = await json('POST', `/api/accounts/${claude.body.id}/login`);
      expect(pendingClaude.body).toMatchObject({ state: 'pending', instructions: expect.stringContaining('claude setup-token') });
      const authorize = new URL(pendingClaude.body.url);
      expect(authorize.origin + authorize.pathname).toBe('https://claude.ai/oauth/authorize');
      expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await json('POST', `/api/accounts/${claude.body.id}/login`)).status).toBe(409);
      expect(await json('POST', `/api/accounts/${claude.body.id}/login/code`, { code: 'authorization-code' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('#state') } });
      expect(await json('POST', `/api/accounts/${claude.body.id}/login/code`, { code: 'authorization-code#wrong-state' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('invalid state') } });
      expect(tokenRequests).toHaveLength(0);
      expect(await json('POST', `/api/accounts/${claude.body.id}/login/code`, { code: `reject-code#${authorize.searchParams.get('state')}` })).toMatchObject({ status: 400, body: { error: 'Anthropic OAuth exchange failed (HTTP 400)' } });
      expect(tokenRequests).toHaveLength(1);
      expect(x.db.accounts.get(claude.body.id)?.secret).toBeNull();
      expect((await json('GET', `/api/accounts/${claude.body.id}/login`)).body.state).toBe('pending');
      const exchanged = await json('POST', `/api/accounts/${claude.body.id}/login/code`, { code: `authorization-code#${authorize.searchParams.get('state')}` });
      expect(exchanged.body).toMatchObject({ state: 'done' });
      expect(tokenRequests[1]).toMatchObject({ code: 'authorization-code', state: authorize.searchParams.get('state'), grant_type: 'authorization_code', code_verifier: expect.any(String) });
      expect(x.db.accounts.get(claude.body.id)).toMatchObject({ secret: 'oauth-access-secret', refresh_token: 'oauth-refresh-secret', token_expires_at: expect.any(Number) });
      expect(x.db.accounts.get(claude.body.id)?.last_login_at).toEqual(expect.any(String));
      expect((await json('GET', `/api/accounts/${claude.body.id}/login`)).body.state).toBe('done');
      expect(JSON.stringify(exchanged.body) + JSON.stringify((await json('GET', '/api/accounts')).body)).not.toMatch(/oauth-(?:access|refresh)-secret/);
      // OAuth credentials reach the DB and token endpoint only: this login never opens a log file.
      expect(fs.existsSync(path.join(x.config.dataDir, 'accounts', claude.body.id, 'login.log'))).toBe(false);

      expect((await json('POST', `/api/accounts/${fallbackClaude.body.id}/login`)).body.state).toBe('pending');
      expect((await json('POST', `/api/accounts/${fallbackClaude.body.id}/login/code`, { code: 'sk-ant-oat01-super-secret-token-value' })).body).toMatchObject({ state: 'done' });
      expect(x.db.accounts.get(fallbackClaude.body.id)).toMatchObject({ secret: 'sk-ant-oat01-super-secret-token-value', refresh_token: null, token_expires_at: null });

      // Cancel while `codex login status` is still confirming: the status child is killed and nothing is stamped.
      const slowCodex = await json('POST', '/api/accounts', { name: 'Slow status Codex', harness: 'codex', kind: 'codex_home' });
      const slowHome = x.db.accounts.get(slowCodex.body.id)!.home!;
      fs.writeFileSync(path.join(slowHome, 'complete'), 'yes'); fs.writeFileSync(path.join(slowHome, 'slow-status'), 'yes');
      expect((await json('POST', `/api/accounts/${slowCodex.body.id}/login`)).body.state).toBe('pending');
      await until(() => fs.existsSync(path.join(slowHome, 'status.pid')));
      const statusPid = Number(fs.readFileSync(path.join(slowHome, 'status.pid'), 'utf8'));
      expect((await json('DELETE', `/api/accounts/${slowCodex.body.id}/login`)).body).toEqual({ state: 'idle' });
      await until(() => !procs.pidExists(statusPid));
      await new Promise((r) => setTimeout(r, 50));
      expect((await json('GET', `/api/accounts/${slowCodex.body.id}/login`)).body).toEqual({ state: 'idle' });
      expect(x.db.accounts.get(slowCodex.body.id)?.last_login_at).toBeNull();
      expect((await json('PUT', '/api/settings/orchestrator', { account: slowCodex.body.id })).status).toBe(400);
      await json('DELETE', `/api/accounts/${slowCodex.body.id}`);

      // Deleting an account during a pending login kills the child and drops the state; nothing is recreated under its home.
      const doomed = await json('POST', '/api/accounts', { name: 'Doomed Codex', harness: 'codex', kind: 'codex_home' });
      const doomedHome = x.db.accounts.get(doomed.body.id)!.home!;
      expect((await json('POST', `/api/accounts/${doomed.body.id}/login`)).body.state).toBe('pending');
      await until(() => fs.existsSync(path.join(doomedHome, 'login.pid')));
      const doomedPid = Number(fs.readFileSync(path.join(doomedHome, 'login.pid'), 'utf8'));
      expect((await json('DELETE', `/api/accounts/${doomed.body.id}`)).body).toEqual({ ok: true });
      await until(() => !procs.pidExists(doomedPid));
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(doomedHome)).toBe(false);
      expect((await json('GET', `/api/accounts/${doomed.body.id}/login`)).status).toBe(404);

      const api = await json('POST', '/api/accounts', { name: 'API login', harness: 'claude', kind: 'api_key', secret: 'api-secret' });
      expect((await json('POST', `/api/accounts/${api.body.id}/login`)).body).toEqual({ state: 'done', instructions: 'paste an API key' });
      await json('DELETE', `/api/accounts/${api.body.id}`);
    } finally {
      x.config.anthropicTokenUrl = oldTokenUrl;
      await new Promise<void>((resolve, reject) => tokenServer.close((err) => err ? reject(err) : resolve()));
      x.config.codexBin = oldCodex;
      await json('DELETE', `/api/accounts/${codex.body.id}/login`);
      await json('DELETE', `/api/accounts/${pendingCodex.body.id}/login`);
      await json('DELETE', `/api/accounts/${failedCodex.body.id}/login`);
      await json('DELETE', `/api/accounts/${claude.body.id}/login`);
      await json('DELETE', `/api/accounts/${fallbackClaude.body.id}/login`);
      await json('DELETE', `/api/accounts/${codex.body.id}`);
      await json('DELETE', `/api/accounts/${pendingCodex.body.id}`);
      await json('DELETE', `/api/accounts/${failedCodex.body.id}`);
      await json('DELETE', `/api/accounts/${claude.body.id}`);
      await json('DELETE', `/api/accounts/${fallbackClaude.body.id}`);
    }
  });
  it('marks a login failed when its background follower rejects', async () => {
    fs.mkdirSync(x.config.dataDir, { recursive: true });
    const oldCodex = x.config.codexBin;
    x.config.codexBin = stubBin('codex-login-log-failure-stub', `
      const fs = require('node:fs'); const path = require('node:path');
      const home = process.env.CODEX_HOME;
      fs.writeFileSync(path.join(home, 'ready'), String(process.pid));
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(home, 'continue'))) return;
        clearInterval(timer); console.log('output after login started'); setInterval(() => {}, 1000);
      }, 10);
    `);
    const account = await json('POST', '/api/accounts', { name: 'Broken login log', harness: 'codex', kind: 'codex_home' });
    const home = x.db.accounts.get(account.body.id)!.home!;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await json('POST', `/api/accounts/${account.body.id}/login`)).body.state).toBe('pending');
      await until(() => fs.existsSync(path.join(home, 'ready')));
      const pid = Number(fs.readFileSync(path.join(home, 'ready'), 'utf8'));
      const loginLog = path.join(x.config.dataDir, 'accounts', account.body.id, 'login.log');
      fs.rmSync(loginLog); fs.mkdirSync(loginLog);
      fs.writeFileSync(path.join(home, 'continue'), 'yes');
      await until(async () => (await json('GET', `/api/accounts/${account.body.id}/login`)).body.state === 'failed');
      await until(() => !procs.pidExists(pid));
      expect((await json('GET', `/api/accounts/${account.body.id}/login`)).body).toMatchObject({ state: 'failed', error: 'login process failed' });
      expect(error).toHaveBeenCalledWith(`accounts: login follow failed for ${account.body.id}`, expect.any(Error));
    } finally {
      error.mockRestore(); x.config.codexBin = oldCodex;
      await json('DELETE', `/api/accounts/${account.body.id}`);
    }
  });
  it('contains an initial login-log write failure and kills the child', async () => {
    fs.mkdirSync(x.config.dataDir, { recursive: true });
    const oldCodex = x.config.codexBin;
    x.config.codexBin = stubBin('codex-login-start-log-failure-stub', `
      const fs = require('node:fs'); const path = require('node:path');
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'login.pid'), String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const account = await json('POST', '/api/accounts', { name: 'Broken initial login log', harness: 'codex', kind: 'codex_home' });
    const home = x.db.accounts.get(account.body.id)!.home!;
    const pidFile = path.join(home, 'login.pid');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const write = vi.spyOn(AccountLogins.prototype as never, 'write' as never).mockImplementationOnce(() => {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
      throw new Error('login log unavailable');
    });
    try {
      expect(await json('POST', `/api/accounts/${account.body.id}/login`)).toMatchObject({ status: 500, body: { error: 'login log unavailable' } });
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await until(() => !procs.pidExists(pid));
      expect((await json('GET', `/api/accounts/${account.body.id}/login`)).body).toMatchObject({ state: 'failed', error: 'login process failed' });
      expect(error).toHaveBeenCalledWith(`accounts: login start failed for ${account.body.id}`, expect.any(Error));
    } finally {
      write.mockRestore(); error.mockRestore(); x.config.codexBin = oldCodex;
      await json('DELETE', `/api/accounts/${account.body.id}`);
    }
  });
  it('accept-review resolves the bead\'s repo and calls through the lifecycle', async () => {
    expect((await json('POST', '/api/tasks/nope-1/accept-review', { note: 'x' })).status).toBe(404);
    const accept = vi.spyOn(x.lifecycle, 'acceptReview').mockResolvedValue(undefined);
    x.store.add(x.t.path, { id: 'ov-2', title: 'Another task' });
    const sid = await x.lifecycle.spawnWorker('r1', 'ov-2', { harness: 'claude' });
    x.fake.emit(x.sessions.handleOf(sid)!, { type: 'turn_end', nativeSessionId: 'n2', cost: 0 });
    await until(() => !x.db.sessions.forBead('ov-2').some((s) => s.status === 'running'));
    x.db.worktrees.update('ov-2', { review_findings: [{ file: null, summary: 'still there', severity: 'must' }] });
    const r = await runAction('/api/tasks/ov-2/accept-review', { note: 'ship it' });
    expect(r).toMatchObject({ status: 202, result: { action: 'accept-review', ok: true } });
    expect(accept).toHaveBeenCalledWith('r1', 'ov-2', 'ship it');
    accept.mockRestore();
  });
  it('refuses to delete while a session runs, then removes worktrees, batches and rows but keeps the branches and their commits', async () => {
    const t = copyTmpRepo(template);
    expect((await json('POST', '/api/repos', { path: t.path, id: 'del-t' })).status).toBe(200);
    const repo = x.db.repos.get('del-t')!;
    x.db.sessions.insert({ id: 'sess-run', harness: 'claude', role: 'worker', bead_id: 'ov-d1', repo_id: 'del-t', native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: t.path, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null });
    x.db.events.append('sess-run', 'assistant_text', { text: 'hello' });
    const busy = await json('DELETE', '/api/repos/del-t');
    expect(busy.status).toBe(409);
    expect(busy.body.sessions).toEqual(['sess-run']);
    x.db.sessions.update('sess-run', { status: 'ended' });
    const wt = await ensureWorktree(repo, 'ov-d1', x.config.worktreesDir);
    x.db.worktrees.upsert({ bead_id: 'ov-d1', repo_id: 'del-t', path: wt.path, branch: wt.branch, base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null , review_round: null, review_findings: null, accepted_note: null });
    x.db.worktrees.upsert({ bead_id: 'ov-d2', repo_id: 'del-t', path: path.join(x.config.worktreesDir, 'gone'), branch: 'bead/ov-d2', base_branch: 'main', verify_status: null, verify_output: null, review_note: null, conflict_files: null, merged_at: null, mr_url: null, batch_id: null, closed_at: null , review_round: null, review_findings: null, accepted_note: null });
    const batch = await x.lifecycle.createBatch('del-t', 'Leftover');
    const batchDir = batchWorktreePath(x.config.worktreesDir, 'del-t', batch.id);
    expect(fs.existsSync(batchDir)).toBe(true);
    sh(t.path, ['checkout', '-q', '-b', 'other']);
    const baseDir = baseWorktreePath(x.config.worktreesDir, 'del-t');
    sh(t.path, ['worktree', 'add', '-q', baseDir, 'main']);
    // Unmerged work on the batch branch (round 8: Remove deleted it while the confirm promised the branches stay).
    const unmerged = commitFile(batchDir, 'r8.txt', 'banana', 'add r8.txt');
    const r = await json('DELETE', '/api/repos/del-t');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, warnings: [], kept_branches: ['bead/ov-d1', batch.branch] });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(x.db.worktrees.forRepo('del-t')).toEqual([]);
    expect(fs.existsSync(batchDir)).toBe(false);
    expect(fs.existsSync(baseDir)).toBe(false);
    expect(fs.existsSync(path.join(x.config.worktreesDir, 'del-t'))).toBe(false); // no empty folder left behind
    expect(x.db.batches.forRepo('del-t')).toEqual([]);
    expect(sh(t.path, ['rev-parse', batch.branch])).toBe(unmerged);
    expect(sh(t.path, ['branch', '--list', 'bead/ov-d1'])).not.toBe('');
    expect(x.db.repos.get('del-t')).toBeUndefined();
    // The repo's sessions and their events are task records too: the rail sums them per repo, so the same path added again kept
    // the whole spend of the registration whose records the dialog said were deleted (round 20 R20-4).
    expect(x.db.sessions.get('sess-run')).toBeUndefined();
    expect(x.db.events.forSession('sess-run')).toEqual([]);
    const costs = (await json('GET', '/api/costs')).body as { repos: { repo_id: string }[] };
    expect(costs.repos.map((c) => c.repo_id)).not.toContain('del-t');
    // The orchestrator hears about it: a live session would otherwise still work on the repo from its preamble.
    expect(x.db.chat.all().at(-1)).toMatchObject({ role: 'system', text: `Repository del-t removed from Overseer by the user; its unfinished batch was dropped: ${batch.id} (in progress, ${batch.branch}); the branch stays in the repository.` });
    expect((await json('DELETE', '/api/repos/del-t')).status).toBe(404);
  });
});

describe('WebSocket', () => {
  it('forwards bus messages', async () => {
    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    const got: WsMessage[] = [];
    ws.addEventListener('message', (m) => got.push(JSON.parse(String(m.data))));
    await new Promise<void>((res) => ws.addEventListener('open', () => res()));
    x.bus.emit('board');
    x.bus.emit('chat');
    x.bus.emit('status');
    x.bus.emit('repos');
    x.bus.emit('event', { id: 1, session_id: 's', seq: 1, type: 'assistant_text', payload: { text: 'x' }, ts: 't' });
    // A process exit reaches the web as its own notice with the session id, ahead of the board rebuild (round 12: Stop lingered for the build's seconds).
    x.bus.emit('session:ended', { session: { id: 's9', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: null, pid: null, pid_started_at: null, start_commit: null, cwd: '/', status: 'ended', started_at: 't', ended_at: 't', cost: null, batch_id: null, log_path: null, log_offset: 0, tier: null, model: null }, lastText: null, lastError: null, files: [] });
    // A new socket first gets the orchestrator's current activity (earlier tests in this file ran a turn), then the office
    // snapshot, then the notices. Activity and office messages are not notices and are ignored here.
    const isNotice = (g: WsMessage) => g.type !== 'orchestrator_activity' && g.type !== 'office' && g.type !== 'office_snapshot';
    await until(() => got.filter(isNotice).length === 6);
    expect(got[0]!.type).toBe('orchestrator_activity');
    const notices = got.filter(isNotice);
    expect(notices.map((g) => g.type)).toEqual(['board', 'chat', 'status', 'repos', 'event', 'session_ended']);
    expect(notices[4]).toEqual({ type: 'event', session_id: 's' }); // the id only: an open Trace refetches on it, payloads do not stream to every tab
    expect(notices[5]).toEqual({ type: 'session_ended', session_id: 's9' });
    ws.close();
  });
});

describe('plans API', () => {
  const steps = [{ title: 'Table', description: '', dependsOn: [] }];
  it('lists, saves, refuses stale revisions and discards', async () => {
    x.db.repos.insert({ id: 'rp', path: '/tmp/rp', base_branch: 'main', verify_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 1, review_rounds: 0 });
    const repoId = 'rp';
    const p = await plans.propose(repoId, 'API plan', steps);
    const list = await app.inject({ method: 'GET', url: '/api/plans' });
    expect(list.json().map((q: { id: string }) => q.id)).toContain(p.id);
    expect((await app.inject({ method: 'GET', url: `/api/plans/${p.id}` })).json()).toMatchObject({ title: 'API plan', revision: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/plans/nope' })).statusCode).toBe(400);

    const saved = await app.inject({ method: 'PUT', url: `/api/plans/${p.id}`, payload: { title: 'API plan 2', steps, revision: 1 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ title: 'API plan 2', revision: 2 });
    expect((await app.inject({ method: 'PUT', url: `/api/plans/${p.id}`, payload: { title: 'stale', steps, revision: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/api/plans/${p.id}`, payload: { title: 'x', steps: [], revision: 2 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/plans/${p.id}`, payload: { title: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/plans/${p.id}/approve`, payload: { revision: 1 } })).statusCode).toBe(409);

    const gone = await app.inject({ method: 'POST', url: `/api/plans/${p.id}/discard` });
    expect(gone.json()).toMatchObject({ status: 'discarded' });
    expect((await app.inject({ method: 'POST', url: `/api/plans/${p.id}/discard` })).statusCode).toBe(409);

    // /api/plans stays drafts-only; /api/plans/all still lists a discarded plan, so it stays reachable.
    expect((await app.inject({ method: 'GET', url: '/api/plans' })).json().map((q: { id: string }) => q.id)).not.toContain(p.id);
    expect((await app.inject({ method: 'GET', url: '/api/plans/all' })).json().map((q: { id: string }) => q.id)).toContain(p.id);
  });
});
