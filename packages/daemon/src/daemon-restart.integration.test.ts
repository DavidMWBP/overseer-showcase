import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchRow, Repo } from '@overseer/shared';
import { openDb } from './db/db';
import { mkTmpRepo, commitFileAsync, shAsync } from './test/tmpgit';
import { batchWorktreePath } from './lifecycle/lifecycle';
import { until } from './test/until';
import { killProcess, stopProcess } from './util/procs';

const started = new Set<number>();

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function stop(pid: number): Promise<void> {
  if (!alive(pid)) return;
  process.kill(pid, 'SIGTERM');
  await until(() => !alive(pid), 10_000, `daemon ${pid} to stop`);
}

afterEach(async () => {
  for (const pid of started) await stop(pid);
  started.clear();
});

/** Every restart successor a daemon in `dataDir` spawned, read from its restart log, so cleanup can stop detached ones it never observed. */
function successors(dataDir: string): number[] {
  try {
    const text = fs.readFileSync(path.join(dataDir, 'daemon-restart.log'), 'utf8');
    return [...text.matchAll(/restart successor (\d+) waiting for parent/g)].map((m) => Number(m[1]));
  } catch { return []; }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no free port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertTemporaryPaths(...paths: string[]): void {
  const liveData = path.join(os.homedir(), '.overseer');
  const checkout = path.resolve(import.meta.dirname, '../../..');
  for (const p of paths) {
    expect(isWithin(os.tmpdir(), p), `${p} must be under the OS temp directory`).toBe(true);
    expect(isWithin(liveData, p), `${p} must be outside ~/.overseer`).toBe(false);
    expect(isWithin(checkout, p), `${p} must be outside the checked-out repository`).toBe(false);
  }
}

function batchRow(id: string, repo: Repo, branch: string): BatchRow {
  const at = new Date().toISOString();
  return { id, repo_id: repo.id, title: `Batch ${id}`, branch, base_branch: repo.base_branch, status: 'review', note: null, history: null, mr_url: null, conflict_files: null, created_at: at, updated_at: at, merged_at: null, merged_commit: null, setup_at: null, waiting_on: null, overlap_files: null };
}

async function addBatchWorktree(dataDir: string, repo: Repo, id: string, branch: string, file: string): Promise<BatchRow> {
  await shAsync(repo.path, ['checkout', '-q', '-b', branch]);
  await commitFileAsync(repo.path, file, `${file}\n`, `add ${file}`);
  await shAsync(repo.path, ['checkout', '-q', repo.base_branch]);
  await shAsync(repo.path, ['worktree', 'add', '-q', batchWorktreePath(path.join(dataDir, 'worktrees'), repo.id, id), branch]);
  return batchRow(id, repo, branch);
}

function readBatch(dbFile: string, id: string): BatchRow | undefined {
  const db = openDb(dbFile);
  try { return db.batches.get(id); } finally { db.sql.close(); }
}

describe('daemon restart integration', () => {
  // These assertions intentionally retain the daemon's production takeover and restart windows.
  // They validate process continuity, not a test-only timeout.
  it('takes the port from a live daemon, then restarts while a board websocket is connected', async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-restart-'));
    const entry = path.resolve(import.meta.dirname, 'index.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    if (!child.pid) throw new Error('daemon did not start');
    started.add(child.pid);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const daemon = async (): Promise<{ pid: number }> => {
      const response = await fetch(`http://127.0.0.1:${port}/api/daemon`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return response.json() as Promise<{ pid: number }>;
    };
    try {
      let first: { pid: number } | undefined;
      await until(async () => { try { first = await daemon(); return true; } catch { return false; } }, 15_000, `initial daemon startup; output: ${output}`);
      started.add(first!.pid);
      const duplicate = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (!duplicate.pid) throw new Error('duplicate daemon did not start');
      started.add(duplicate.pid);
      let duplicateOutput = '';
      duplicate.stdout.on('data', (chunk) => { duplicateOutput += String(chunk); });
      duplicate.stderr.on('data', (chunk) => { duplicateOutput += String(chunk); });
      // A plain start retries the busy port for 15 s before it takes it over, after about 2 s of startup.
      await until(() => !alive(first!.pid), 40_000, `first daemon to be stopped by the takeover; output: ${duplicateOutput}`);
      let live: { pid: number } | undefined;
      await until(async () => { try { live = await daemon(); return live.pid === duplicate.pid; } catch { return false; } }, 20_000, `takeover daemon startup; output: ${duplicateOutput}`);
      expect(duplicate.exitCode).toBeNull();
      expect(duplicateOutput).toContain(`is taking port ${port} from the Overseer daemon ${first!.pid}`);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('socket error')); });
      const response = await fetch(`http://127.0.0.1:${port}/api/daemon/restart`, { method: 'POST' });
      expect(response.status).toBe(202);
      let successor: { pid: number } | undefined;
      await until(async () => {
        try { const current = await daemon(); if (current.pid === live!.pid) return false; successor = current; return true; }
        catch { return false; }
      }, 20_000, `restart successor; output: ${output}`);
      started.add(successor!.pid);
      expect(successor!.pid).not.toBe(live!.pid);
      expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(200);
      await until(() => !alive(live!.pid), 10_000, 'old daemon to exit');
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      for (const pid of successors(dataDir)) started.add(pid);
      for (const pid of started) await stop(pid);
      started.clear();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 160_000);

  it('keeps a rejected local merge through a daemon restart and pushes it with the next merge', async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-base-push-live-'));
    const tempRepo = mkTmpRepo('overseer-base-push-repo-');
    const origin = path.join(tempRepo.root, 'origin.git');
    const other = path.join(tempRepo.root, 'remote-checkout');
    const dbFile = path.join(dataDir, 'overseer.db');
    const repo: Repo = { id: 'pushlive', path: tempRepo.path, base_branch: 'main', verify_command: null, review_command: null, setup_command: null, merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 0, model_filter: null };
    const entry = path.resolve(import.meta.dirname, 'index.ts');
    let output = '';

    try {
      await shAsync(repo.path, ['clone', '-q', '--bare', repo.path, origin]);
      await shAsync(repo.path, ['remote', 'add', 'origin', origin]);
      await shAsync(repo.path, ['clone', '-q', origin, other]);
      await commitFileAsync(other, 'remote.txt', 'remote change\n', 'remote change');
      const remoteCommit = await shAsync(other, ['rev-parse', 'HEAD']);
      await shAsync(other, ['push', 'origin', 'main']);
      const first = await addBatchWorktree(dataDir, repo, 'pushlive-b1', 'feature/live-push-1', 'first.txt');
      assertTemporaryPaths(dataDir, tempRepo.root, repo.path, origin, other, path.join(dataDir, 'worktrees'));
      const db = openDb(dbFile, { batchIdSuffix: () => '' });
      db.repos.insert(repo);
      db.batches.insert(first);
      db.sql.close();

      const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_REAP_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      if (!child.pid) throw new Error('daemon did not start');
      started.add(child.pid);
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      const daemon = async (): Promise<{ pid: number }> => {
        const response = await fetch(`http://127.0.0.1:${port}/api/daemon`);
        if (!response.ok) throw new Error(`status ${response.status}`);
        return response.json() as Promise<{ pid: number }>;
      };
      await until(async () => { try { return !!(await daemon()).pid; } catch { return false; } }, 15_000, `daemon startup; output: ${output}`);

      const firstMergeResponse = await fetch(`http://127.0.0.1:${port}/api/batches/${first.id}/merge`, { method: 'POST' });
      expect(firstMergeResponse.status).toBe(202);
      let chat = '';
      await until(async () => {
        try { const response = await fetch(`http://127.0.0.1:${port}/api/chat?limit=500`); chat = await response.text(); return chat.includes('Base push for pushlive to origin failed:'); }
        catch { return false; }
      }, 20_000, `rejected push notice; output: ${output}`);
      const chatPage = JSON.parse(chat) as { rows: { text: string }[] };
      const pushNotices = chatPage.rows.filter((row) => row.text.startsWith('Base push for pushlive to origin failed:'));
      expect(pushNotices).toHaveLength(1);
      expect(pushNotices[0]?.text).toContain('Run `git push origin main`');
      expect(pushNotices[0]?.text).toContain(repo.path);
      const firstMerged = readBatch(dbFile, first.id);
      expect(firstMerged).toMatchObject({ status: 'merged', merged_commit: expect.any(String) });
      expect(await shAsync(origin, ['rev-parse', 'refs/heads/main'])).toBe(remoteCommit);
      await until(async () => (await shAsync(repo.path, ['branch', '--list', first.branch])) === '', 10_000, 'first batch branch cleanup');

      await shAsync(repo.path, ['fetch', 'origin', 'main']);
      await shAsync(repo.path, ['merge', '--no-edit', 'origin/main']);
      const second = await addBatchWorktree(dataDir, repo, 'pushlive-b2', 'feature/live-push-2', 'second.txt');
      const secondDb = openDb(dbFile);
      secondDb.batches.insert(second);
      secondDb.sql.close();

      const beforeRestart = await daemon();
      const restart = await fetch(`http://127.0.0.1:${port}/api/daemon/restart`, { method: 'POST' });
      expect(restart.status).toBe(202);
      let successor: { pid: number } | undefined;
      await until(async () => {
        try { const current = await daemon(); if (current.pid === beforeRestart.pid) return false; successor = current; return true; }
        catch { return false; }
      }, 20_000, `restart successor; output: ${output}`);
      started.add(successor!.pid);
      await until(() => !alive(beforeRestart.pid), 10_000, 'old daemon to exit');
      expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(200);

      const secondMergeResponse = await fetch(`http://127.0.0.1:${port}/api/batches/${second.id}/merge`, { method: 'POST' });
      expect(secondMergeResponse.status).toBe(202);
      await until(() => readBatch(dbFile, second.id)?.status === 'merged', 15_000, 'second batch merge after restart');
      const finalBase = await shAsync(repo.path, ['rev-parse', 'main']);
      await until(async () => (await shAsync(origin, ['rev-parse', 'refs/heads/main'])) === finalBase, 20_000, 'base pushed after restart');
      await shAsync(origin, ['merge-base', '--is-ancestor', firstMerged!.merged_commit!, finalBase]);
      await shAsync(origin, ['merge-base', '--is-ancestor', remoteCommit, finalBase]);
      await shAsync(origin, ['merge-base', '--is-ancestor', readBatch(dbFile, second.id)!.merged_commit!, finalBase]);
    } finally {
      for (const pid of successors(dataDir)) started.add(pid);
      for (const pid of started) await stop(pid);
      started.clear();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      fs.rmSync(tempRepo.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 90_000);

  it('closes with a board websocket and an MCP stream open, well inside the restart bound', async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-restart-mcp-'));
    const entry = path.resolve(import.meta.dirname, 'index.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child.pid) throw new Error('daemon did not start');
    started.add(child.pid);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const daemon = async (): Promise<{ pid: number }> => {
      const response = await fetch(`http://127.0.0.1:${port}/api/daemon`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return response.json() as Promise<{ pid: number }>;
    };
    let socket: WebSocket | undefined;
    let sse: Response | undefined;
    try {
      let first: { pid: number } | undefined;
      await until(async () => { try { first = await daemon(); return true; } catch { return false; } }, 15_000, `daemon startup; output: ${output}`);
      started.add(first!.pid);
      socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
      await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error('socket error')); });
      // A GET SSE stream on the MCP route holds a hijacked socket that Fastify does not track as a reply.
      sse = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { accept: 'text/event-stream' } });
      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type')).toContain('text/event-stream');
      const response = await fetch(`http://127.0.0.1:${port}/api/daemon/restart`, { method: 'POST' });
      expect(response.status).toBe(202);
      await until(() => !alive(first!.pid), 20_000, `old daemon to exit; output: ${output}`);
      const lines = fs.readFileSync(path.join(dataDir, 'daemon.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { ts: string; msg: string });
      const opening = lines.find((line) => line.msg.includes(`waiting for parent ${first!.pid} to close`));
      const closed = lines.find((line) => line.msg.includes('overseer daemon shutdown complete'));
      expect(opening, 'the parent logs the start of its bounded shutdown').toBeDefined();
      expect(closed, 'the onClose hook runs and closes the database').toBeDefined();
      expect(lines.map((line) => line.msg).join('\n')).not.toContain('could not close cleanly');
      expect(Date.parse(closed!.ts) - Date.parse(opening!.ts)).toBeLessThan(2_000);
      let successor: { pid: number } | undefined;
      await until(async () => {
        try { const current = await daemon(); if (current.pid === first!.pid) return false; successor = current; return true; }
        catch { return false; }
      }, 20_000, `restart successor; output: ${output}`);
      started.add(successor!.pid);
      expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(200);
    } finally {
      if (socket) socket.close();
      if (sse?.body) { try { await sse.body.cancel(); } catch { /* already closed */ } }
      for (const pid of successors(dataDir)) started.add(pid);
      for (const pid of started) await stop(pid);
      started.clear();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);

  it('stops only the daemon process, so its detached workers keep running', async () => {
    const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid); setInterval(() => {}, 1000);";
    const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
    if (!parent.pid) throw new Error('parent did not start');
    started.add(parent.pid);
    const workerPid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk).trim()))));
    started.add(workerPid);
    try {
      await stopProcess(parent.pid);
      await until(() => !alive(parent.pid!), 10_000, 'daemon process to stop');
      expect(alive(workerPid)).toBe(true);
    } finally {
      for (const pid of started) await stop(pid);
      started.clear();
    }
  }, 20_000);

  it('refuses to start and kills nothing when a foreign process holds the port', async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-foreign-port-'));
    const sockets = new Set<import('node:net').Socket>();
    const foreign = createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
    foreign.on('error', () => {});
    await new Promise<void>((resolve, reject) => { foreign.once('error', reject); foreign.listen(port, '127.0.0.1', resolve); });
    const entry = path.resolve(import.meta.dirname, 'index.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child.pid) throw new Error('daemon did not start');
    started.add(child.pid);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`daemon did not exit; output: ${output}`)), 40_000);
        child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      expect(code).toBe(1);
      expect(output).toContain(`port ${port} is held by pid ${process.pid}`);
      expect(output).toContain('which is not an Overseer daemon; nothing was stopped');
      expect(foreign.listening).toBe(true);
    } finally {
      started.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
      if (alive(child.pid)) await stop(child.pid);
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 60_000);

  it('does not let a watch start take a port from a running daemon', async () => {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-watch-holder-'));
    const watchDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-watch-start-'));
    const entry = path.resolve(import.meta.dirname, 'index.ts');
    const daemon = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    if (!daemon.pid) throw new Error('daemon did not start');
    started.add(daemon.pid);
    try {
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/daemon`)).ok; } catch { return false; } }, 15_000, 'daemon startup');
      const watcher = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', entry], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_DATA_DIR: watchDataDir, OVERSEER_WATCH: '1', OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      if (!watcher.pid) throw new Error('watcher did not start');
      started.add(watcher.pid);
      let output = '';
      watcher.stdout.on('data', (chunk) => { output += String(chunk); });
      watcher.stderr.on('data', (chunk) => { output += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`watcher did not exit; output: ${output}`)), 40_000);
        watcher.once('exit', (value) => { clearTimeout(timer); resolve(value); });
      });
      expect(code).toBe(1);
      expect(alive(daemon.pid)).toBe(true);
      expect(output).toContain(`port ${port} is held by pid ${daemon.pid}`);
      expect(output).toContain('watcher mode will not stop it');
    } finally {
      for (const pid of started) await stop(pid);
      started.clear();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      fs.rmSync(watchDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 60_000);

  it('keeps the root pnpm process and Vite server alive across a daemon restart', async () => {
    const port = await freePort();
    let webPort = await freePort();
    while (webPort === port) webPort = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-root-restart-'));
    const rootDir = path.resolve(import.meta.dirname, '../../..');
    const command = process.platform === 'win32'
      ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm start'] }
      : { file: 'pnpm', args: ['start'] };
    const root = spawn(command.file, command.args, {
      cwd: rootDir,
      env: { ...process.env, OVERSEER_PORT: String(port), OVERSEER_WEB_PORT: String(webPort), OVERSEER_DATA_DIR: dataDir, OVERSEER_STALL_MIN: '0', OVERSEER_BD: 'overseer-test-no-bd' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    if (!root.pid) throw new Error('root pnpm start did not launch');
    let output = '';
    root.stdout.on('data', (chunk) => { output += String(chunk); });
    root.stderr.on('data', (chunk) => { output += String(chunk); });
    const daemon = async (): Promise<{ pid: number }> => {
      const response = await fetch(`http://127.0.0.1:${webPort}/api/daemon`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      return response.json() as Promise<{ pid: number }>;
    };
    let firstPid: number | undefined;
    let successorPid: number | undefined;
    try {
      try {
        await until(async () => {
          try {
            firstPid = (await daemon()).pid;
            return (await fetch(`http://127.0.0.1:${webPort}/`)).ok;
          } catch { return false; }
        }, 20_000, 'root daemon and Vite startup');
      } catch (error) {
        throw new Error(`${String(error)}; root exit: ${root.exitCode}; command: ${command.file} ${command.args.join(' ')}; cwd: ${rootDir}; output: ${output}`);
      }
      const response = await fetch(`http://127.0.0.1:${webPort}/api/daemon/restart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(202);
      await until(async () => {
        try { successorPid = (await daemon()).pid; return successorPid !== firstPid; }
        catch { return false; }
      }, 20_000, `root daemon restart; output: ${output}`);
      await until(() => output.includes('packages/daemon start: Done'), 5_000, 'daemon workspace script completion');
      expect(root.exitCode).toBeNull();
      expect(output).not.toContain('packages/web start: Failed');
      // Vite colours its banner when the environment forces colour.
      expect(output.replace(/\x1b\[[0-9;]*m/g, '').match(/VITE v/g)).toHaveLength(1);
      expect((await fetch(`http://127.0.0.1:${webPort}/`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${webPort}/api/status`)).status).toBe(200);
    } finally {
      if (process.platform === 'win32') await killProcess(root.pid);
      else { try { process.kill(-root.pid, 'SIGTERM'); } catch { /* already gone */ } }
      if (firstPid) await stop(firstPid);
      if (successorPid) await stop(successorPid);
      for (const pid of successors(dataDir)) await stop(pid);
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 90_000);
});
