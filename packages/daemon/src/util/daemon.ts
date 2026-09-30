import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isAlive, killProcess, processStartTime, runCapture, stopProcess } from './procs';
import { log } from './log';

const RESTART_PARENT_ENV = 'OVERSEER_RESTART_AFTER_PID';
const RESTART_PARENT_STARTED_ENV = 'OVERSEER_RESTART_AFTER_STARTED_AT';
const RESTART_PARENT_WAIT_TIMEOUT_MS = 60_000;
export const RESTART_INSTALL_COMMAND = 'pnpm install --frozen-lockfile';
export const RESTART_INSTALL_TIMEOUT_MS = 5 * 60_000;
const RESTART_OUTPUT_TAIL_LINES = 20;

interface RestartCommandResult { code: number; output: string; timedOut: boolean }
type InstallRunner = (command: string, cwd: string, timeoutMs: number) => Promise<RestartCommandResult>;
interface RestartFailure { reason: string; output: string[] }

interface RelaunchOptions {
  spawn?: typeof spawn;
  exit?: (code: number) => void;
  pid?: number;
  closeTimeoutMs?: number;
  /** Test seam for the successor's startup acknowledgement. */
  waitForSuccessor?: (child: ReturnType<typeof spawn>, file: string, offset: number) => Promise<void>;
  sourceRoot?: string;
  startupInputHash?: string;
  installRunner?: InstallRunner;
}

/** Hashes the root dependency inputs and manifests for the packages/* workspace. */
export function restartInputHash(sourceRoot: string): string {
  const root = path.resolve(sourceRoot);
  const packagesRoot = path.join(root, 'packages');
  const files = [path.join(root, 'package.json'), path.join(root, 'pnpm-lock.yaml'), path.join(root, 'pnpm-workspace.yaml')];
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(packagesRoot, entry.name, 'package.json');
    if (fs.existsSync(manifest)) files.push(manifest);
  }
  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/')).update('\0');
    hash.update(fs.readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

/** A startup hash failure must not stop the daemon; undefined forces an install on its next restart. */
export function startupRestartInputHash(sourceRoot: string): string | undefined {
  try { return restartInputHash(sourceRoot); }
  catch (error) {
    log.warn('overseer daemon could not read restart inputs at startup; the next restart will install dependencies', error);
    return undefined;
  }
}

function tailLines(output: string, maxLines = RESTART_OUTPUT_TAIL_LINES): string[] {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-maxLines);
}

function restartError(reason: string, output: string[]): Error & { restartFailure: RestartFailure } {
  return Object.assign(new Error(reason), { restartFailure: { reason, output: output.slice(-RESTART_OUTPUT_TAIL_LINES) } });
}

function restartLogTail(file: string, offset: number): string[] {
  try {
    const end = fs.statSync(file).size;
    if (end <= offset) return [];
    const start = Math.max(offset, end - 128 * 1024);
    const bytes = Buffer.alloc(end - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, bytes, 0, bytes.length, start); } finally { fs.closeSync(fd); }
    let output = bytes.toString('utf8');
    if (start > offset) {
      const newline = output.indexOf('\n');
      output = newline < 0 ? '' : output.slice(newline + 1);
    }
    return tailLines(output);
  } catch { return []; }
}

function runInstall(command: string, cwd: string, timeoutMs: number): Promise<RestartCommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output += String(chunk);
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, output, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      output = String(error);
      resolve({ code: 1, output, timedOut: false });
      return;
    }
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => { append(Buffer.from(String(error))); finish(1); });
    child.once('close', (code) => finish(code ?? 1));
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) { finish(1); return; }
      void killProcess(child.pid).catch(() => {}).finally(() => finish(1));
    }, timeoutMs);
  });
}

export async function gitHead(sourceRoot: string): Promise<string | null> {
  const result = await runCapture('git', ['rev-parse', '--short', 'HEAD'], { cwd: sourceRoot });
  const head = result.stdout.trim();
  return result.code === 0 && head ? head : null;
}

/** Kinds and counts of the process's live resources, logged when `app.close()` times out so the stuck handle is named. */
export function openHandleSummary(): string {
  const counts = new Map<string, number>();
  for (const kind of process.getActiveResourcesInfo()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none';
}

export async function relaunchDaemon(app: FastifyInstance, dataDir: string, options: RelaunchOptions = {}): Promise<void> {
  if (options.sourceRoot) {
    let currentHash: string;
    try { currentHash = restartInputHash(options.sourceRoot); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw restartError(`Could not calculate restart input hash: ${detail}`, []);
    }
    if (options.startupInputHash === undefined || currentHash !== options.startupInputHash) {
      const result = await (options.installRunner ?? runInstall)(RESTART_INSTALL_COMMAND, options.sourceRoot, RESTART_INSTALL_TIMEOUT_MS);
      if (result.code !== 0 || result.timedOut) {
        const reason = result.timedOut
          ? `${RESTART_INSTALL_COMMAND} timed out after ${RESTART_INSTALL_TIMEOUT_MS / 1000} seconds`
          : `${RESTART_INSTALL_COMMAND} exited with code ${result.code}`;
        throw restartError(reason, tailLines(result.output));
      }
    }
  }
  const file = path.join(dataDir, 'daemon-restart.log');
  fs.mkdirSync(dataDir, { recursive: true });
  const offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const output = fs.openSync(file, 'a');
  const parentPid = options.pid ?? process.pid;
  const parentStartedAt = await processStartTime(parentPid);
  const child = (options.spawn ?? spawn)(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: { ...process.env, [RESTART_PARENT_ENV]: String(parentPid), [RESTART_PARENT_STARTED_ENV]: parentStartedAt ?? '' },
    detached: true, windowsHide: true, stdio: ['ignore', output, output],
  });
  fs.closeSync(output);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // `spawn` only says that Node created a process. Wait until the successor has loaded its entrypoint and reached the
  // parent gate; if it exits during startup, leave this daemon serving rather than handing the port to nothing.
  // A successor left alive here would wait for this parent forever and bind whenever it exits, racing any later restart.
  try { await (options.waitForSuccessor ?? waitForSuccessorReady)(child, file, offset); }
  catch (error) {
    if (child.pid) { try { process.kill(child.pid); } catch { /* already gone */ } }
    child.unref();
    const failure = restartError(error instanceof Error ? error.message : String(error), restartLogTail(file, offset));
    log.error(`overseer daemon restart abandoned successor ${child.pid ?? 'unknown'}; this daemon keeps serving`, failure);
    throw failure;
  }
  log.info(`overseer daemon restart spawned successor ${child.pid ?? 'unknown'}; waiting for parent ${parentPid} to close`);
  child.unref();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('daemon shutdown timed out')), options.closeTimeoutMs ?? 10_000); }),
    ]);
  } catch (error) {
    // Exit 0 anyway: the successor is live, and a non-zero code would make `pnpm -r --parallel start` tear down Vite and the root process.
    log.error(`overseer daemon restart parent ${parentPid} could not close cleanly; exiting so successor ${child.pid ?? 'unknown'} can start; open handles: ${openHandleSummary()}`, error);
  } finally {
    if (timer) clearTimeout(timer);
    (options.exit ?? process.exit)(0);
  }
}

export async function waitForSuccessorReady(child: ReturnType<typeof spawn>, file: string, offset: number): Promise<void> {
  let exited = false;
  let fd: number | undefined;
  let position = offset;
  child.once('exit', () => { exited = true; });
  try {
    for (let elapsed = 0; elapsed < 30_000; elapsed += 100) {
      if (exited) throw new Error(`restart successor ${child.pid ?? 'unknown'} exited before it reached startup`);
      try {
        fd ??= fs.openSync(file, 'r');
        const end = fs.fstatSync(fd).size;
        if (end > position) {
          const bytes = Buffer.alloc(end - position);
          fs.readSync(fd, bytes, 0, bytes.length, position);
          position = end;
          if (bytes.toString('utf8').includes(`restart successor ${child.pid} waiting for parent`)) return;
        }
      } catch { /* the child has not opened its log yet */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`restart successor ${child.pid ?? 'unknown'} did not reach startup within 30 seconds`);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export async function listenWithRetry(
  listen: () => Promise<unknown>,
  retryBusy = false,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries?: number,
): Promise<void> {
  for (let retries = 0;; retries += 1) {
    try { await listen(); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !retryBusy || (maxRetries !== undefined && retries >= maxRetries)) throw error;
      log.warn(`overseer daemon ${process.pid} could not bind because the port is still in use; retrying in 500ms`);
      await wait(500);
    }
  }
}

interface TakeOverDeps {
  /** The pid the daemon on `port` reports through `GET /api/daemon`, or null when the holder is not an Overseer daemon. */
  daemonPid?: (port: number) => Promise<{ pid: number; dataDir: string | null; sourceRoot: string | null } | null>;
  /** This process's data dir; a daemon on the port that serves another data dir (or does not say) is never stopped. */
  dataDir?: string;
  /** This process's source root; another checkout must never replace its daemon even if it shares the data dir. */
  sourceRoot?: string;
  /** The pid and command of whatever listens on `port`, for the error message when it is not ours. */
  holder?: (port: number) => Promise<{ pid: number; name: string } | null>;
  stop?: (pid: number) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  /** Watch starts inspect a holder for a useful error, but must never stop it. */
  takeOver?: boolean;
}

async function daemonPidOn(port: number): Promise<{ pid: number; dataDir: string | null; sourceRoot: string | null } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/daemon`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const body = await response.json() as { pid?: unknown; data_dir?: unknown; source_root?: unknown };
    return typeof body.pid === 'number' ? { pid: body.pid, dataDir: typeof body.data_dir === 'string' ? body.data_dir : null, sourceRoot: typeof body.source_root === 'string' ? body.source_root : null } : null;
  } catch { return null; }
}

async function holderOf(port: number): Promise<{ pid: number; name: string } | null> {
  if (process.platform === 'win32') {
    const { stdout } = await runCapture('netstat', ['-ano', '-p', 'TCP']);
    const line = stdout.split('\n').find((l) => /LISTENING/.test(l) && new RegExp(`[:.]${port}\\s`).test(l));
    const pid = Number(line?.trim().split(/\s+/).at(-1));
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const tasks = await runCapture('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return { pid, name: tasks.stdout.split(',')[0]?.replace(/"/g, '').trim() || 'unknown' };
  }
  const { stdout } = await runCapture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  const pid = Number(stdout.split('\n').find((l) => l.startsWith('p'))?.slice(1));
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const name = stdout.split('\n').find((l) => l.startsWith('c'))?.slice(1) ?? 'unknown';
  return { pid, name };
}

function sameDir(a: string | null, b: string): boolean {
  if (a === null) return false;
  const norm = (dir: string) => { const r = path.resolve(dir); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}

/**
 * A plain start takes the port from another Overseer daemon: that daemon alone is stopped (never its workers, which this daemon
 * adopts), and `true` says the port is ours to bind. A port held by anything else is left alone and answered with `false`.
 * `null` means the bind raced with a departing holder, so the caller should retry the bind before deciding it is foreign.
 */
export async function takeOverPort(port: number, deps: TakeOverDeps = {}): Promise<boolean | null> {
  const daemon = await (deps.daemonPid ?? daemonPidOn)(port);
  if (daemon !== null) {
    const pid = daemon.pid;
    if (deps.takeOver === false) {
      const holder = await (deps.holder ?? holderOf)(port);
      log.error(`overseer daemon cannot start: port ${port} is held by pid ${pid} (${holder?.name ?? 'Overseer daemon'}); watcher mode will not stop it`);
      return false;
    }
    if (deps.dataDir !== undefined && !sameDir(daemon.dataDir, deps.dataDir)) {
      log.error(`overseer daemon cannot start: port ${port} is held by the Overseer daemon ${pid} with data dir ${daemon.dataDir ?? 'unknown'}, not ${deps.dataDir}; another install is not stopped`);
      return false;
    }
    if (deps.sourceRoot !== undefined && !sameDir(daemon.sourceRoot, deps.sourceRoot)) {
      log.error(`overseer daemon cannot start: port ${port} is held by the Overseer daemon ${pid} from source root ${daemon.sourceRoot ?? 'unknown'}, not ${deps.sourceRoot}; another checkout is not stopped`);
      return false;
    }
    log.warn(`overseer daemon ${process.pid} is taking port ${port} from the Overseer daemon ${pid} and stopping that process only; its workers keep running and are adopted`);
    await (deps.stop ?? stopProcess)(pid);
    const holder = deps.holder ?? holderOf;
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
      if ((await holder(port))?.pid !== pid) return true;
      await wait(500);
    }
    log.error(`overseer daemon cannot take port ${port}: Overseer daemon ${pid} still holds it after 10 seconds of shutdown`);
    return false;
  }
  const holder = await (deps.holder ?? holderOf)(port);
  if (!holder) {
    log.warn(`overseer daemon could not identify the holder of port ${port}; retrying the bind before takeover`);
    return null;
  }
  log.error(`overseer daemon cannot start: port ${port} is held by ${holder ? `pid ${holder.pid} (${holder.name})` : 'an unknown process'}, which is not an Overseer daemon; nothing was stopped`);
  return false;
}

export async function waitForRestartParent(
  env: NodeJS.ProcessEnv = process.env,
  alive: (pid: number, startedAt: string | null) => Promise<boolean> = isAlive,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const raw = env[RESTART_PARENT_ENV];
  const startedAtRaw = env[RESTART_PARENT_STARTED_ENV];
  delete env[RESTART_PARENT_ENV];
  delete env[RESTART_PARENT_STARTED_ENV];
  if (!raw) return false;
  const parentPid = Number(raw);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    log.warn(`overseer daemon ignored invalid ${RESTART_PARENT_ENV}=${raw}`);
    return false;
  }
  const startedAt = startedAtRaw || null;
  log.info(`overseer daemon restart successor ${process.pid} waiting for parent ${parentPid} to exit`);
  // A recycled pid must not be mistaken for the parent, and the wait must not hang forever if the parent never exits:
  // `alive(pid, startedAt)` (which `isAlive` also uses for worker adoption) distinguishes "still the parent" from "gone or
  // replaced", and `alive(pid, null)` alone tells a reused pid (still running, different process) from a truly exited one.
  const deadline = Date.now() + RESTART_PARENT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await alive(parentPid, startedAt))) {
      if (await alive(parentPid, null)) {
        log.info(`overseer daemon restart parent pid ${parentPid} was reused by another process; successor ${process.pid} is starting`);
      } else {
        log.info(`overseer daemon restart parent ${parentPid} exited; successor ${process.pid} is starting`);
      }
      return true;
    }
    await wait(100);
  }
  log.warn(`overseer daemon restart gave up waiting for parent ${parentPid} after ${RESTART_PARENT_WAIT_TIMEOUT_MS / 1000}s; successor ${process.pid} is starting anyway`);
  return true;
}
