import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Repo, ServerRow, SessionRow } from '@overseer/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from './db/db';
import { Bus } from './bus';
import { FakeAdapter } from './harness/fake';
import { SessionManager } from './sessions/manager';
import { MemoryTaskStore } from './beads/memory';
import { LocalMergeProvider } from './git/provider';
import { Lifecycle } from './lifecycle/lifecycle';
import { Prober } from './lifecycle/probe';
import { Orchestrator } from './orchestrator/orchestrator';
import { Plans } from './plans/plans';
import { Discussions } from './discussions/discussions';
import { Servers } from './servers/servers';
import { AccountLogins } from './accounts/login';
import { loadConfig } from './config';
import { mkTmpRepo } from './test/tmpgit';
import { buildApp } from './app';
import { ActionJobs } from './api/jobs';

const LOG_DIR = path.join(os.tmpdir(), 'overseer-test-sessions'); // the fake adapter never writes there

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A session row the previous daemon left running, whose pid is gone: exactly what `lifecycle.recover()` ends. */
function deadRunningSession(): SessionRow {
  return {
    id: 'stale-1', harness: 'claude', role: 'orchestrator', bead_id: null, repo_id: null, native_session_id: null,
    pid: null, pid_started_at: null, start_commit: null, cwd: '/wt', batch_id: null, log_path: null, log_offset: 0,
    tier: null, model: null, status: 'running', started_at: new Date().toISOString(), ended_at: null, cost: 0,
  } as SessionRow;
}

/** An ended worker session: `lifecycle.recover()` leaves it alone, and its per-session MCP url has an identity. */
function endedWorkerSession(): SessionRow {
  return { ...deadRunningSession(), id: 'worker-1', role: 'worker', bead_id: 'b-1', status: 'ended', ended_at: new Date().toISOString() } as SessionRow;
}

/** A server row the previous daemon left running, whose process is gone: exactly what `servers.recover()` stops. */
function deadRunningServer(): ServerRow {
  return {
    id: 'srv-1', session_id: 'worker-1', repo_id: 'r-1', bead_id: 'b-1', name: null, command: 'node -e ""', cwd: '/wt',
    pid: null, pid_started_at: null, log_path: null, status: 'running', started_at: new Date().toISOString(), stopped_at: null,
  } as ServerRow;
}

function setup(ready: Promise<void>) {
  const t = mkTmpRepo();
  const db = openDb(':memory:');
  const bus = new Bus();
  const sessions = new SessionManager(db, { claude: new FakeAdapter(), codex: new FakeAdapter('codex') }, bus, LOG_DIR);
  const store = new MemoryTaskStore();
  // Its own temp data dir: the daemon the user runs keeps its rows, worktrees and logs under the default path.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-gate-'));
  const config = { ...loadConfig({ OVERSEER_DATA_DIR: dataDir }), port: 0, worktreesDir: t.worktreesDir };
  expect(config.dataDir).not.toBe(loadConfig({}).dataDir);
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const orchestrator = new Orchestrator({ db, sessions, bus, config });
  // The wiring index.ts uses: a recovery notice travels to the orchestrator, and a `wake` one starts a session.
  const lifecycle = new Lifecycle({ db, store, sessions, bus, config, provider: () => new LocalMergeProvider(), notify: (m, o) => orchestrator.systemMessage(m, o) });
  const servers = new Servers(db, path.join(dataDir, 'servers'));
  const plans = new Plans({ db, store, lifecycle, bus, notify: async () => {} });
  const discussions = new Discussions({ db, sessions, bus, config });
  const prober = new Prober({ db, bus, worktreesDir: config.worktreesDir, notify: async () => {} });
  const daemon = { pid: process.pid, startedAt: new Date().toISOString(), commit: 'abc', sourceRoot: t.path, sourceHead: async () => 'abc', relaunch: async () => undefined, restarting: false };
  const app = buildApp({ db, bus, config, store, sessions, lifecycle, orchestrator, plans, discussions, servers, daemon, logins: new AccountLogins(db, config), prober, jobs: new ActionJobs(bus), ready });
  cleanup.push(() => app.close());
  return { app, db, lifecycle, servers, orchestrator, store, repoPath: t.path };
}

/**
 * The fixture `lifecycle.test.ts` builds for its own recovery cases: a real git repo, a bead in the store and a worker
 * dispatched into its own worktree. Leaving the session row running with no live pid is what the previous daemon leaves
 * behind, so `lifecycle.recover()` reopens the bead and posts the wake notice that starts the orchestrator.
 */
async function seedLostWorker(x: ReturnType<typeof setup>): Promise<void> {
  const repo: Repo = {
    id: 'r1', path: x.repoPath, base_branch: 'main', verify_command: `node -e "process.exit(0)"`, setup_command: null,
    merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 3, review_rounds: 0, model_filter: null,
  };
  x.db.repos.insert(repo);
  x.store.add(repo.path, { id: 'ov-1', title: 'Add greeting', description: 'Write hello.txt' });
  await x.lifecycle.spawnWorker('r1', 'ov-1', { harness: 'claude' });
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as { port: number }).port;
}

/** Long enough for an ungated request, socket or MCP call to have been answered from the pre-recovery rows. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 300); });

/** Tracks whether a promise has settled, so the test can assert that the gate is still holding it. */
function track<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let settled = false;
  const done = p.then((v) => { settled = true; return v; }, (e) => { settled = true; throw e; });
  return { p: done, settled: () => settled };
}

describe('daemon startup gate', () => {
  it('answers no request, websocket or MCP tool call while recovery has not run', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const { app, db, lifecycle, servers } = setup(ready);
    db.sessions.insert(deadRunningSession());
    db.sessions.insert(endedWorkerSession());
    db.servers.insert(deadRunningServer());
    const port = await listen(app);

    // All three are issued while the rows are still the pre-recovery ones: without the gate they are answered from them.
    const request = track(fetch(`http://127.0.0.1:${port}/api/sessions`).then((r) => r.json() as Promise<SessionRow[]>));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    cleanup.push(() => socket.close());
    const opened = track(new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('socket error'));
    }));
    const client = new Client({ name: 'test', version: '0' });
    cleanup.push(() => client.close());
    // `servers.recover()` is about to stop this row; answered now, `list_servers` would report it as running.
    const listed = track(client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/worker-1`)))
      .then(() => client.callTool({ name: 'list_servers', arguments: {} }))
      .then((r) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as unknown[]));

    // The health probe the web polls answers at once, so the page stays offline instead of loading a stale board.
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const healthBody = await health.json();
    expect([health.status, healthBody]).toEqual([503, { ok: false, ready: false }]);

    await settle();
    expect([request.settled(), opened.settled(), listed.settled()]).toEqual([false, false, false]);

    await lifecycle.recover();
    await servers.recover();
    release();

    // Each one now carries what recovery decided: the session ended, the server stopped.
    expect((await request.p)[0]!.status).toBe('ended');
    await opened.p;
    expect(await listed.p).toEqual([]);
    expect((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json())).toEqual({ ok: true });
  });

  it('completes startup when recovery itself starts the orchestrator against this MCP server', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const x = setup(ready);
    const { app, db, lifecycle } = x;
    db.sessions.insert(endedWorkerSession());
    await seedLostWorker(x);
    const port = await listen(app);
    expect(db.sessions.latest('orchestrator')).toBeUndefined();

    // A held MCP call, issued the way a session started during recovery issues one, before recovery has run.
    const client = new Client({ name: 'test', version: '0' });
    cleanup.push(() => client.close());
    const call = track(client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/worker-1`)))
      .then(() => client.callTool({ name: 'list_servers', arguments: {} })));

    // index.ts' order: the port is bound, recovery runs, and only then is the gate opened. Recovery reopens the lost
    // worker's bead and its notice starts the orchestrator, whose MCP server is this daemon, but starting it spawns the
    // CLI and returns: the turn and its tool calls are never awaited, so the held call above cannot stall recovery.
    const startup = lifecycle.recover().then(() => { release(); return ready; });
    await expect(Promise.race([startup, new Promise((_, r) => { setTimeout(() => r(new Error('startup deadlocked')), 5_000); })])).resolves.toBeUndefined();

    // Recovery did what it does: the lost session ended, the bead reopened, and its own wake notice started a session.
    expect(db.sessions.forBead('ov-1')[0]?.status).toBe('failed');
    expect((await x.store.show(x.repoPath, 'ov-1'))?.status).toBe('open');
    expect(db.sessions.latest('orchestrator')?.status).toBe('running');
    await call.p; // and the call the gate held is answered once startup has opened it
  });
});
